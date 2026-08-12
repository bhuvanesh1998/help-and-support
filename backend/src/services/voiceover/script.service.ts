/**
 * script.service.ts — Frames → timed voiceover script.
 * ────────────────────────────────────────────────────
 * Provider-agnostic: the configured adapter (Claude / ChatGPT / Gemini) receives
 * the same frames and prompt and returns the same segment shape.
 *
 * Frames are sent in batches so a long walkthrough never builds one oversized
 * request. Each batch returns segments covering its own span of the video; the
 * caller stitches them into one continuous script.
 *
 * Every segment carries a word budget derived from its duration
 * (WORDS_PER_MINUTE), which is what keeps the finished audio in sync with the
 * visuals — narration that overruns its span is the usual way timed VO fails.
 *
 * The API key is passed in per call and never persisted here.
 */

import { getProvider, isRetryable } from './providers/index.js';
import type { ProviderRequest, ProviderResult, RawSegment, VisionProvider } from './providers/index.js';
import type { VoiceoverSettings } from './settings.service.js';
import type { Frame, VoSegment, VoTone } from './types.js';
import { countWords, timecode, wordBudgetFor } from './types.js';

const TONE_GUIDANCE: Record<VoTone, string> = {
  instructional:
    'Teach the viewer to perform the action. Second person, present tense, imperative where natural ("Select Settings, then choose Integrations"). No hype, no adjectives that do not carry information.',
  marketing:
    'Lead with the outcome and the pain it removes. Concrete benefits over adjectives — name the saved step, the removed wait, the avoided error. Never use filler like "seamless", "robust", "unlock", or "game-changing".',
  onboarding:
    'Welcome a first-time user. Warm but efficient; briefly say why a screen matters before saying what to do on it. Assume no prior product knowledge and expand any term the UI does not itself explain.',
};

export interface ScriptContext {
  appName: string;
  audience: string;
  tone: VoTone;
  apiKey: string;
  model: string;
  settings: VoiceoverSettings;
  frames: Frame[];
  durationSec: number;
  onSegment: (segment: VoSegment) => void;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  signal: AbortSignal;
}

function buildPrompt(ctx: ScriptContext, batch: Frame[], from: number, to: number): string {
  const frameList = batch
    .map(
      (f, i) =>
        `Image ${i + 1}: t=${f.at.toFixed(1)}s (${timecode(f.at)})${
          f.isSceneChange ? ' — screen transition detected here' : ''
        }`,
    )
    .join('\n');

  const spanSec = to - from;
  const spanBudget = wordBudgetFor(spanSec, ctx.settings.wordsPerMinute);
  const wps = (ctx.settings.wordsPerMinute / 60).toFixed(1);
  const exampleWords = Math.round((10 * ctx.settings.wordsPerMinute) / 60);

  return `You are writing the voiceover script for a product walkthrough video of ${ctx.appName}.

Audience: ${ctx.audience}
Tone: ${TONE_GUIDANCE[ctx.tone]}

The video is ${ctx.durationSec.toFixed(1)}s long. The ${batch.length} images below are stills taken from it, in order:
${frameList}

Cover ONLY the span ${from.toFixed(1)}s to ${to.toFixed(1)}s. Break that span into narration segments:

- Segments must tile the span contiguously: the first starts at ${from.toFixed(1)}, the last ends at ${to.toFixed(1)}, and each segment's startSec equals the previous segment's endSec. No gaps, no overlaps.
- Each segment is ${ctx.settings.minSegmentSec}-${ctx.settings.maxSegmentSec} seconds. Prefer boundaries at the screen transitions flagged above.
- WORD BUDGET IS A HARD LIMIT. Narration runs at roughly ${wps} words per second, so a segment's script must contain at most (duration in seconds x ${wps}) words. A 10-second segment gets at most ${exampleWords} words. The whole span of ${spanSec.toFixed(1)}s allows about ${spanBudget} words total. Going over means the audio will not fit the picture.
- "onScreen" is a short factual note on what is visible and what the user does (for the editor, never spoken).
- "script" is the spoken line. Plain prose only: no timecodes, no numbers written as digits where a word reads better, no stage directions, no speaker labels, no markdown. It will be sent straight to a text-to-speech engine, so anything you write will be read aloud literally.
- Describe only what is actually visible in the stills. Do not invent features, names, or numbers you cannot see.
- Write continuous narration: each line should follow naturally from the previous one rather than restarting the topic.`;
}

/** Attempts per batch, and the waits between them. */
const RETRY_DELAYS_MS = [3_000, 9_000, 20_000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Job cancelled'));
      },
      { once: true },
    );
  });
}

/**
 * Call the provider, retrying transient failures with a growing wait.
 *
 * Rate limits and overload (429/503) are routine on free-tier accounts, and a
 * single spike would otherwise discard a whole job's extracted frames. Genuine
 * failures — a bad key, an unknown model, a malformed request — are not
 * retryable and surface immediately.
 */
async function generateWithRetry(
  provider: VisionProvider,
  request: ProviderRequest,
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<ProviderResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await provider.generate(request);
    } catch (err) {
      lastError = err;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!isRetryable(err) || delay === undefined || request.signal.aborted) throw err;

      onLog(
        'warn',
        `${(err as Error).message.split('\n')[0]} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1}).`,
      );
      await sleep(delay, request.signal);
    }
  }

  throw lastError;
}

/** Clamp, order and gap-fill the model's segments so they tile [from, to] exactly. */
function normaliseBatch(raw: RawSegment[], from: number, to: number): RawSegment[] {
  const usable = raw
    .filter((s) => typeof s.startSec === 'number' && typeof s.endSec === 'number')
    .map((s) => ({
      ...s,
      startSec: Math.min(Math.max(s.startSec!, from), to),
      endSec: Math.min(Math.max(s.endSec!, from), to),
    }))
    .filter((s) => s.endSec! > s.startSec!)
    .sort((a, b) => a.startSec! - b.startSec!);

  if (usable.length === 0) return [];

  // Butt each segment against the next so the timeline has no holes.
  for (let i = 0; i < usable.length - 1; i += 1) {
    usable[i]!.endSec = usable[i + 1]!.startSec;
  }
  usable[0]!.startSec = from;
  usable[usable.length - 1]!.endSec = to;

  return usable.filter((s) => s.endSec! - s.startSec! >= 0.5);
}

/**
 * Walk the frames in batches and build the full segment list. A batch that
 * fails is logged and skipped — the rest of the script still comes through.
 */
export async function runScripter(ctx: ScriptContext): Promise<VoSegment[]> {
  const segments: VoSegment[] = [];
  const perBatch = ctx.settings.framesPerBatch;
  const provider = getProvider(ctx.settings.provider);
  let index = 0;
  /**
   * Kept so a total failure can report *why* rather than a bare "no narration
   * could be generated" — the per-batch cause was previously buried in the log.
   */
  let lastFailure = '';

  for (let start = 0; start < ctx.frames.length; start += perBatch) {
    if (ctx.signal.aborted) throw new Error('Job cancelled');

    const batch = ctx.frames.slice(start, start + perBatch);
    if (batch.length === 0) continue;

    const from = batch[0]!.at;
    const isLastBatch = start + perBatch >= ctx.frames.length;
    const to = isLastBatch ? ctx.durationSec : ctx.frames[start + perBatch]!.at;
    if (to <= from) continue;

    ctx.onLog('info', `Writing narration for ${timecode(from)}–${timecode(to)}…`);

    let result: ProviderResult;
    try {
      result = await generateWithRetry(
        provider,
        {
          apiKey: ctx.apiKey,
          model: ctx.model,
          maxTokens: ctx.settings.maxTokens,
          effort: ctx.settings.effort,
          frames: batch
            .filter((f) => f.base64)
            .map((f) => ({ at: f.at, base64: f.base64! })),
          prompt: buildPrompt(ctx, batch, from, to),
          signal: ctx.signal,
        },
        ctx.onLog,
      );
    } catch (err) {
      lastFailure = (err as Error).message;
      ctx.onLog('error', `${timecode(from)}–${timecode(to)}: ${lastFailure}`);
      continue;
    }

    if (result.refused) {
      ctx.onLog('warn', `${timecode(from)}–${timecode(to)}: the model declined this section.`);
      continue;
    }

    const normalised = normaliseBatch(result.segments, from, to);
    if (normalised.length === 0) {
      ctx.onLog('warn', `${timecode(from)}–${timecode(to)}: no usable segments returned.`);
      continue;
    }

    for (const raw of normalised) {
      const startSec = Number(raw.startSec!.toFixed(2));
      const endSec = Number(raw.endSec!.toFixed(2));
      const script = (raw.script ?? '').replace(/\s+/g, ' ').trim();
      const budget = wordBudgetFor(endSec - startSec, ctx.settings.wordsPerMinute);
      const words = countWords(script);

      // Attach the still nearest this segment's start for the review table.
      const nearest = ctx.frames.reduce((best, frame) =>
        Math.abs(frame.at - startSec) < Math.abs(best.at - startSec) ? frame : best,
      );

      index += 1;
      const segment: VoSegment = {
        index,
        startSec,
        endSec,
        onScreen: (raw.onScreen ?? '').trim(),
        script,
        wordBudget: budget,
        wordCount: words,
        imageUrl: nearest.imageUrl,
      };

      if (words > budget) {
        ctx.onLog(
          'warn',
          `Segment ${index} (${timecode(startSec)}) runs ${words} words against a ${budget}-word budget — trim before recording.`,
        );
      }

      segments.push(segment);
      ctx.onSegment(segment);
    }
  }

  if (segments.length === 0) {
    throw new Error(
      lastFailure
        ? `No narration could be generated. ${ctx.settings.provider} (${ctx.model}) failed: ${lastFailure}`
        : `No narration could be generated. ${ctx.settings.provider} (${ctx.model}) returned no usable segments.`,
    );
  }
  return segments;
}
