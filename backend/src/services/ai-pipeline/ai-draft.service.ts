/**
 * ai-draft.service.ts — Phase 2: AI Content Generation (backend)
 * ────────────────────────────────────────────────────────────────
 * For each screen group, sends the screenshots + DOM context to the Claude
 * vision API and parses a structured tutorial (page + ordered steps).
 * Progress is reported per group via the onTutorial callback.
 *
 * The Anthropic key is passed in per call and never persisted.
 */

import type { CapturedScreen, DraftTutorial, ScreenGroup } from './types.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface DraftContext {
  appName: string;
  anthropicKey: string;
  model: string;
  screens: CapturedScreen[];
  groups: ScreenGroup[];
  onTutorial: (tutorial: DraftTutorial) => void;
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  signal: AbortSignal;
}

interface AIPageDraft {
  page?: { title?: string; description?: string; routePath?: string };
  steps?: Array<{ title?: string; instructionsMd?: string; screenshotId?: string }>;
}

function buildGroupPrompt(
  appName: string,
  groupName: string,
  routePath: string,
  groupScreens: CapturedScreen[],
): string {
  const domSummary = groupScreens
    .map((s, i) => {
      const d = s.dom;
      const inputs =
        d.inputs.map((f) => `${f.label || f.placeholder || f.id} (${f.type})`).join(', ') ||
        'none';
      const buttons = d.buttons.map((b) => b.text).join(', ') || 'none';
      return `
Screen ${i + 1}: "${s.name}" [id: ${s.id}]
URL: ${d.url}
Heading: ${d.heading}
Inputs: ${inputs}
Buttons: ${buttons}
Body excerpt: ${d.bodyText.slice(0, 200)}`;
    })
    .join('\n');

  const ids = groupScreens.map((s) => s.id).join(', ');

  return `You are a senior technical documentation writer creating user guides for ${appName}.

I am showing you ${groupScreens.length} sequential screenshots from the "${groupName}" flow.

DOM context for each screen:
${domSummary}

Your task: Write a complete tutorial page covering all these screens as sequential steps.

Output ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "page": {
    "title": "Action-oriented tutorial title (e.g., 'How to Log In to ${appName}')",
    "description": "1-2 sentences describing what this tutorial covers and who it helps.",
    "routePath": "${routePath}"
  },
  "steps": [
    {
      "stepNumber": 1,
      "title": "Verb-first step title (e.g., 'Enter your Email Address')",
      "instructionsMd": "## Step Title\\n\\nMarkdown with **bold UI labels** and numbered sub-actions. 3-6 sentences.",
      "screenshotId": "${groupScreens[0]?.id ?? ''}"
    }
  ]
}

Rules:
- Every screenshot must become exactly 1 step, in order.
- Use **bold** for every UI element name (button, field, link, tab).
- Be specific: mention exact label text, button placement (left/right/top).
- screenshotId must be one of these exact IDs: ${ids}
- Do not invent features that are not visible in the screenshots.
- instructionsMd must start with "## " followed by the step title.`;
}

function parseAIResponse(text: string): AIPageDraft {
  const clean = text
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(clean) as AIPageDraft;
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as AIPageDraft;
    throw new Error(`AI returned an unparseable response: ${clean.slice(0, 200)}`);
  }
}

async function callClaude(
  ctx: DraftContext,
  images: string[],
  prompt: string,
): Promise<AIPageDraft> {
  const content: unknown[] = images.map((data) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  }));
  content.push({ type: 'text', text: prompt });

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ctx.anthropicKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ctx.model,
      max_tokens: 6000,
      messages: [{ role: 'user', content }],
    }),
    signal: ctx.signal,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { content?: Array<{ text?: string }> };
  const text = data.content?.[0]?.text ?? '';
  return parseAIResponse(text);
}

export async function runDrafter(ctx: DraftContext): Promise<DraftTutorial[]> {
  const tutorials: DraftTutorial[] = [];

  for (const group of ctx.groups) {
    if (ctx.signal.aborted) throw new Error('Job cancelled');

    const groupScreens = group.screenIds
      .map((id) => ctx.screens.find((s) => s.id === id))
      .filter((s): s is CapturedScreen => !!s);

    if (groupScreens.length === 0) continue;

    const images = groupScreens.map((s) => s.base64 ?? '').filter(Boolean);
    if (images.length === 0) {
      ctx.onLog('warn', `${group.name}: no screenshots available — skipped`);
      continue;
    }

    ctx.onLog('info', `Drafting "${group.name}" (${groupScreens.length} screens)…`);

    try {
      const prompt = buildGroupPrompt(ctx.appName, group.name, group.routePath, groupScreens);
      const draft = await callClaude(ctx, images, prompt);

      const steps = (draft.steps ?? []).map((step, i) => {
        const screenshotId = step.screenshotId ?? groupScreens[i]?.id ?? '';
        const matched = ctx.screens.find((s) => s.id === screenshotId) ?? groupScreens[i];
        return {
          stepNumber: i + 1,
          title: step.title ?? `Step ${i + 1}`,
          instructionsMd: step.instructionsMd ?? '',
          screenshotId,
          imageUrl: matched?.imageUrl ?? null,
        };
      });

      const tutorial: DraftTutorial = {
        groupId: group.id,
        groupName: group.name,
        page: {
          title: draft.page?.title ?? group.name,
          description: draft.page?.description ?? '',
          routePath: draft.page?.routePath ?? group.routePath,
        },
        steps,
      };

      tutorials.push(tutorial);
      ctx.onTutorial(tutorial);
      ctx.onLog('info', `Drafted "${tutorial.page.title}" with ${steps.length} steps`);
    } catch (err) {
      ctx.onLog('error', `${group.name}: ${(err as Error).message}`);
    }
  }

  return tutorials;
}
