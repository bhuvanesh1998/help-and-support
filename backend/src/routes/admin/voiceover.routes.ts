/**
 * voiceover.routes.ts — Drive the video → timed voiceover script flow.
 *
 * Mounted BEFORE the global `authenticate` middleware because the SSE stream
 * and the file downloads cannot send an Authorization header (EventSource and
 * plain browser navigation both lack one) and authenticate via a `?token=`
 * query param instead. All other routes still require a Bearer token.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import { MulterError } from 'multer';
import AdmZip from 'adm-zip';
import { parseAccessToken } from '../../middleware/auth.middleware.js';
import { AppError } from '../../utils/app-error.js';
import { videoUpload } from '../../lib/upload.js';
import {
  getKey,
  isCredentialId,
  listKeyStatus,
  saveKey,
  deleteKey,
} from '../../services/voiceover/keys.service.js';
import {
  TIMELINE_INDEX,
  deleteAudio,
  deleteClip,
  listAudio,
  listAudioFiles,
  saveClip,
} from '../../services/voiceover/audio-store.service.js';
import { buildTimeline } from '../../services/voiceover/timeline.service.js';
import {
  DEFAULT_TTS_MODEL,
  TTS_PROVIDER,
  listModels as listTtsModels,
  listVoices,
  removeClipFile,
  renderClip,
} from '../../services/voiceover/tts.service.js';
import {
  PROVIDER_META,
  PROVIDERS,
  getProvider,
  isProviderId,
} from '../../services/voiceover/providers/index.js';
import {
  cancelJob,
  getJob,
  snapshot,
  startJob,
  startRegenerateJob,
  subscribe,
  unsubscribe,
} from '../../services/voiceover/job-manager.js';
import {
  BOUNDS,
  EFFORT_LEVELS,
  envDefaults,
  getSettings,
  resetSettings,
  saveSettings,
} from '../../services/voiceover/settings.service.js';
import {
  deleteScript,
  getScript,
  listFilterOptions,
  listScripts,
  updateSegmentText,
} from '../../services/voiceover/script-store.service.js';
import { timecode } from '../../services/voiceover/types.js';
import type { VoSegment, VoTone } from '../../services/voiceover/types.js';

export const voiceoverRouter: Router = Router();

const TONES = new Set<VoTone>(['instructional', 'marketing', 'onboarding']);

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function q(req: Request, key: string): string {
  const v = req.query[key];
  return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '';
}

/** Bearer-header auth for JSON endpoints. */
function requireBearer(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or malformed Authorization header');
  }
  const payload = parseAccessToken(header.slice(7));
  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
}

/** Query-token auth for the SSE stream and file downloads (no headers available). */
function requireQueryToken(req: Request, _res: Response, next: NextFunction): void {
  const token = q(req, 'token');
  if (!token) throw AppError.unauthorized('Missing token');
  const payload = parseAccessToken(token);
  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
}

/**
 * Run the video uploader and translate its failures into 400s.
 *
 * The size limit is read per request from the saved settings, so an admin can
 * raise it in the UI and have the next upload honour it without a restart.
 * Multer rejects (wrong type, over the limit) surface as plain Errors, which the
 * global handler would otherwise report as a 500 — a bad file pick is the
 * caller's problem, not a server fault.
 */
async function acceptVideo(req: Request, res: Response, next: NextFunction): Promise<void> {
  const settings = await getSettings();
  videoUpload(settings.maxVideoUploadMb).single('video')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          AppError.badRequest(`Video is larger than the ${settings.maxVideoUploadMb} MB limit.`),
        );
        return;
      }
      next(AppError.badRequest(`Upload rejected: ${err.message}`));
      return;
    }
    next(AppError.badRequest((err as Error).message || 'Video upload failed.'));
  });
}

/** Resolve a job the caller owns, or throw. */
function ownedJob(req: Request) {
  const job = getJob(p(req, 'id'));
  if (!job) throw AppError.notFound('Job not found or expired');
  if (job.userId !== req.user?.id) throw AppError.notFound('Job not found or expired');
  return job;
}

// ── Config & settings ────────────────────────────────────────────────────────

/** GET /api/admin/voiceover/config — effective settings + capabilities for the UI. */
voiceoverRouter.get('/config', requireBearer, async (_req: Request, res: Response) => {
  const [settings, keys] = await Promise.all([getSettings(), listKeyStatus()]);
  res.json({
    settings,
    bounds: BOUNDS,
    providers: PROVIDERS.map((id) => ({ id, ...PROVIDER_META[id] })),
    keys,
    efforts: [...EFFORT_LEVELS],
    tones: [...TONES],
    /** The env baseline, shown as "reset to" in the UI. */
    envDefaults: envDefaults(),
  });
});

// ── Provider keys ────────────────────────────────────────────────────────────

/** GET /api/admin/voiceover/keys — connection status per provider (no secrets). */
voiceoverRouter.get('/keys', requireBearer, async (_req: Request, res: Response) => {
  res.json({ keys: await listKeyStatus() });
});

/** PUT /api/admin/voiceover/keys/:provider — validate against the provider, then store. */
voiceoverRouter.put('/keys/:provider', requireBearer, async (req: Request, res: Response) => {
  const provider = p(req, 'provider');
  if (!isCredentialId(provider)) throw AppError.badRequest('Unknown provider');

  const body = req.body as Record<string, unknown>;
  const key = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : '';
  if (!key) throw AppError.badRequest('apiKey is required');

  const result = await saveKey(provider, key, req.user!.id);
  if (!result.ok) throw AppError.badRequest(result.error ?? 'Key validation failed');
  res.json({ keys: result.status });
});

/**
 * GET /api/admin/voiceover/models/:provider — models the account can use now.
 * Asked of the provider rather than hardcoded, because provider model IDs are
 * retired on their own schedule and a stale list fails as a bare 404 at
 * generation time.
 */
voiceoverRouter.get('/models/:provider', requireBearer, async (req: Request, res: Response) => {
  const provider = p(req, 'provider');
  if (!isProviderId(provider)) throw AppError.badRequest('Unknown provider');

  const apiKey = await getKey(provider);
  if (!apiKey) {
    throw AppError.badRequest(
      `Connect a ${PROVIDER_META[provider].label} key first — the model list comes from your account.`,
    );
  }

  try {
    res.json({ models: await getProvider(provider).listModels(apiKey) });
  } catch (err) {
    throw AppError.badRequest(`Could not list models: ${(err as Error).message}`);
  }
});

/** DELETE /api/admin/voiceover/keys/:provider */
voiceoverRouter.delete('/keys/:provider', requireBearer, async (req: Request, res: Response) => {
  const provider = p(req, 'provider');
  if (!isCredentialId(provider)) throw AppError.badRequest('Unknown provider');
  res.json({ keys: await deleteKey(provider) });
});

/** PUT /api/admin/voiceover/settings — validate, clamp and persist. */
voiceoverRouter.put('/settings', requireBearer, async (req: Request, res: Response) => {
  const settings = await saveSettings(
    (req.body ?? {}) as Record<string, unknown>,
    req.user!.id,
  );
  res.json({ settings });
});

/** DELETE /api/admin/voiceover/settings — revert to the environment baseline. */
voiceoverRouter.delete('/settings', requireBearer, async (_req: Request, res: Response) => {
  res.json({ settings: await resetSettings() });
});

// ── Jobs ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/voiceover/jobs
 * multipart/form-data: video (file), appName, audience?, tone?, model?
 */
voiceoverRouter.post(
  '/jobs',
  requireBearer,
  acceptVideo,
  async (req: Request, res: Response) => {
    if (!req.file) {
      throw AppError.badRequest('No video uploaded. Use form-data field "video".');
    }

    // Multer has already written the upload to disk. Any rejection from here on
    // must remove it, or failed attempts accumulate as orphaned video files.
    const videoPath = req.file.path;
    const reject = (message: string): never => {
      try {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      } catch {
        /* best effort — the job never took ownership of the file */
      }
      throw AppError.badRequest(message);
    };

    const body = req.body as Record<string, unknown>;
    const appName = typeof body['appName'] === 'string' ? body['appName'].trim() : '';
    if (!appName) reject('appName is required');

    const audience =
      typeof body['audience'] === 'string' && body['audience'].trim()
        ? body['audience'].trim()
        : 'End users of the application';

    const toneRaw = typeof body['tone'] === 'string' ? body['tone'] : '';
    const tone: VoTone = TONES.has(toneRaw as VoTone) ? (toneRaw as VoTone) : 'instructional';

    // Settings are resolved once here and handed to the job, so the whole run
    // uses one consistent snapshot even if an admin edits them mid-job.
    const settings = await getSettings();
    const model = settings.model;

    const apiKey = await getKey(settings.provider);
    if (!apiKey) {
      reject(
        `No ${PROVIDER_META[settings.provider].label} key is connected. Add one under VO Settings before generating a script.`,
      );
    }

    const id = startJob({
      userId: req.user!.id,
      videoPath,
      videoName: req.file.originalname,
      appName,
      audience,
      tone,
      apiKey: apiKey!,
      model,
      provider: settings.provider,
      settings,
    });

    res.status(202).json({ jobId: id });
  },
);

/** GET /api/admin/voiceover/jobs/:id — current snapshot. */
voiceoverRouter.get('/jobs/:id', requireBearer, (req: Request, res: Response) => {
  res.json(snapshot(ownedJob(req)));
});

/** POST /api/admin/voiceover/jobs/:id/cancel */
voiceoverRouter.post('/jobs/:id/cancel', requireBearer, (req: Request, res: Response) => {
  const job = ownedJob(req);
  const cancelled = cancelJob(job.id);
  if (!cancelled) throw AppError.badRequest('Job has already finished');
  res.json({ cancelled: true });
});

/** GET /api/admin/voiceover/jobs/:id/stream?token=… — SSE progress. */
voiceoverRouter.get('/jobs/:id/stream', requireQueryToken, (req: Request, res: Response) => {
  const job = ownedJob(req);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Override helmet's default same-origin CORP so the cross-origin (4200 → 3000)
  // EventSource is not blocked by the browser.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.flushHeaders?.();

  subscribe(job, res);

  // Heartbeat to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe(job, res);
  });
});

// ── Saved scripts ────────────────────────────────────────────────────────────

function safeSlug(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9\-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'voiceover'
  );
}

/**
 * GET /api/admin/voiceover/scripts — the library listing.
 * Optional `search`, `status`, `tone`, `provider`, `limit`. Filtering happens in
 * the query rather than the client so the list stays correct as it grows.
 */
voiceoverRouter.get('/scripts', requireBearer, async (req: Request, res: Response) => {
  const limit = Number.parseInt(q(req, 'limit') || '100', 10);
  const [scripts, filters] = await Promise.all([
    listScripts({
      search: q(req, 'search'),
      status: q(req, 'status'),
      tone: q(req, 'tone'),
      provider: q(req, 'provider'),
      limit: Number.isFinite(limit) ? limit : 100,
    }),
    listFilterOptions(),
  ]);
  res.json({ scripts, filters });
});

/** GET /api/admin/voiceover/scripts/:id — one script with its segments. */
voiceoverRouter.get('/scripts/:id', requireBearer, async (req: Request, res: Response) => {
  const script = await getScript(p(req, 'id'));
  if (!script) throw AppError.notFound('Script not found');
  res.json({ script });
});

/**
 * POST /api/admin/voiceover/scripts/:id/regenerate — same frames, new tone.
 * Body: { tone, appName?, audience? }
 *
 * Runs the scripter over the source script's stored stills, so no re-upload and
 * no ffmpeg work. The result is a new script linked back as a tone variant.
 */
voiceoverRouter.post(
  '/scripts/:id/regenerate',
  requireBearer,
  async (req: Request, res: Response) => {
    const source = await getScript(p(req, 'id'));
    if (!source) throw AppError.notFound('Script not found');
    if (!source.canRegenerate) {
      throw AppError.badRequest(
        'The stills for this script are no longer stored, so it cannot be re-toned. Upload the video again.',
      );
    }

    const body = req.body as Record<string, unknown>;
    const toneRaw = typeof body['tone'] === 'string' ? body['tone'] : '';
    if (!TONES.has(toneRaw as VoTone)) throw AppError.badRequest('A valid tone is required');
    const tone = toneRaw as VoTone;

    const settings = await getSettings();
    const apiKey = await getKey(settings.provider);
    if (!apiKey) {
      throw AppError.badRequest(
        `No ${PROVIDER_META[settings.provider].label} key is connected. Add one under VO Settings.`,
      );
    }

    const jobId = startRegenerateJob({
      userId: req.user!.id,
      // Variants always point at the original frame owner, never at each other.
      sourceScriptId: source.sourceScriptId ?? source.id,
      tone,
      appName: typeof body['appName'] === 'string' ? body['appName'] : undefined,
      audience: typeof body['audience'] === 'string' ? body['audience'] : undefined,
      apiKey,
      model: settings.model,
      provider: settings.provider,
      settings,
      source: {
        videoName: source.videoName,
        appName: source.appName,
        audience: source.audience,
        durationSec: source.durationSec,
        width: source.width,
        height: source.height,
        fps: source.fps,
      },
    });

    res.status(202).json({ jobId });
  },
);

/** DELETE /api/admin/voiceover/scripts/:id — segments cascade. */
voiceoverRouter.delete('/scripts/:id', requireBearer, async (req: Request, res: Response) => {
  const removed = await deleteScript(p(req, 'id'));
  if (!removed) throw AppError.notFound('Script not found');
  res.json({ deleted: true });
});

/** The human-facing reference doc: timecodes, on-screen action, VO, budget. */
function buildScriptMarkdown(
  appName: string,
  videoName: string,
  segments: VoSegment[],
  wordsPerMinute: number,
): string {
  const totalWords = segments.reduce((sum, s) => sum + s.wordCount, 0);
  const over = segments.filter((s) => s.wordCount > s.wordBudget);
  const spokenSec = Math.round((totalWords / wordsPerMinute) * 60);

  const rows = segments
    .map((s) => {
      const flag = s.wordCount > s.wordBudget ? ' (over)' : '';
      const onScreen = s.onScreen.replace(/\|/g, '\|');
      const line = s.script.replace(/\|/g, '\|');
      const length = (s.endSec - s.startSec).toFixed(1);
      return `| ${s.index} | ${timecode(s.startSec)}-${timecode(s.endSec)} | ${length}s | ${onScreen} | ${line} | ${s.wordCount}/${s.wordBudget}${flag} |`;
    })
    .join('\n');

  const overLine = over.length
    ? `**Over budget:** ${over.length} segment(s) marked "(over)" — trim before recording.\n`
    : '';

  return [
    `# Voiceover script — ${appName}`,
    '',
    `**Source video:** ${videoName}`,
    `**Segments:** ${segments.length}`,
    `**Total words:** ${totalWords} (~${spokenSec}s spoken at ${wordsPerMinute} wpm)`,
    overLine,
    '> Timecodes are for your editing timeline only. Do **not** paste this file into',
    '> a text-to-speech engine — it will read the numbers aloud. Use the clean',
    '> per-segment files under `segments/` for that.',
    '',
    '| # | In-Out | Length | On screen | Voiceover | Words |',
    '|---|--------|--------|-----------|-----------|-------|',
    rows,
    '',
  ].join('\n');
}

/**
 * GET /api/admin/voiceover/scripts/:id/export?token=…
 * Returns a zip: the timed script plus one clean TTS-ready file per segment.
 * Reads the stored record, so it keeps working long after the job has expired.
 */
voiceoverRouter.get(
  '/scripts/:id/export',
  requireQueryToken,
  async (req: Request, res: Response) => {
    const script = await getScript(p(req, 'id'));
    if (!script) throw AppError.notFound('Script not found');
    if (script.segments.length === 0) throw AppError.badRequest('This script has no segments');

    const zip = new AdmZip();
    zip.addFile(
      'voiceover-script.md',
      Buffer.from(
        buildScriptMarkdown(
          script.appName,
          script.videoName,
          script.segments,
          script.wordsPerMinute,
        ),
        'utf8',
      ),
    );

    for (const s of script.segments) {
      zip.addFile(
        `segments/${String(s.index).padStart(2, '0')}.txt`,
        Buffer.from(`${s.script}\n`, 'utf8'),
      );
    }

    // A single combined read-through, for one continuous take.
    zip.addFile(
      'segments/all-segments.txt',
      Buffer.from(`${script.segments.map((s) => s.script).join('\n\n')}\n`, 'utf8'),
    );

    const buffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeSlug(script.videoName)}-voiceover.zip"`,
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  },
);

// ── Narration audio (ElevenLabs) ─────────────────────────────────────────────

/** The stored ElevenLabs key, or a 400 explaining how to connect one. */
async function requireTtsKey(): Promise<string> {
  const key = await getKey(TTS_PROVIDER);
  if (!key) {
    throw AppError.badRequest(
      'No ElevenLabs key is connected. Add one under VO Settings to render audio.',
    );
  }
  return key;
}

/** GET /api/admin/voiceover/tts/voices — voices on the connected account. */
voiceoverRouter.get('/tts/voices', requireBearer, async (_req: Request, res: Response) => {
  const key = await requireTtsKey();
  try {
    const [voices, models] = await Promise.all([listVoices(key), listTtsModels(key)]);
    res.json({ voices, models, defaultModel: DEFAULT_TTS_MODEL });
  } catch (err) {
    throw AppError.badRequest((err as Error).message);
  }
});

/** GET /api/admin/voiceover/scripts/:id/audio — clips rendered so far. */
voiceoverRouter.get('/scripts/:id/audio', requireBearer, async (req: Request, res: Response) => {
  res.json({ audio: await listAudio(p(req, 'id')) });
});

/**
 * POST /api/admin/voiceover/scripts/:id/audio/:index — render one segment.
 * Body: { voiceId, voiceName?, modelId? }
 *
 * One line per request so the client can show real progress, retry a single bad
 * take, and never lose finished clips to one failure mid-batch.
 */
voiceoverRouter.post(
  '/scripts/:id/audio/:index',
  requireBearer,
  async (req: Request, res: Response) => {
    const script = await getScript(p(req, 'id'));
    if (!script) throw AppError.notFound('Script not found');

    const index = Number.parseInt(p(req, 'index'), 10);
    const segment = script.segments.find((s) => s.index === index);
    if (!segment) throw AppError.notFound('Segment not found');
    if (!segment.script.trim()) throw AppError.badRequest('That segment has no narration text');

    const body = req.body as Record<string, unknown>;
    const voiceId = typeof body['voiceId'] === 'string' ? body['voiceId'].trim() : '';
    if (!voiceId) throw AppError.badRequest('voiceId is required');
    const voiceName = typeof body['voiceName'] === 'string' ? body['voiceName'] : voiceId;
    const modelId =
      typeof body['modelId'] === 'string' && body['modelId'].trim()
        ? body['modelId'].trim()
        : DEFAULT_TTS_MODEL;

    const key = await requireTtsKey();
    try {
      const clip = await renderClip(key, segment.script, voiceId, modelId);
      const saved = await saveClip(script.id, index, { voiceId, voiceName, modelId }, clip);
      res.json({ clip: saved });
    } catch (err) {
      throw AppError.badRequest((err as Error).message);
    }
  },
);

/** DELETE /api/admin/voiceover/scripts/:id/audio — drop every clip and its file. */
voiceoverRouter.delete(
  '/scripts/:id/audio',
  requireBearer,
  async (req: Request, res: Response) => {
    res.json({ deleted: await deleteAudio(p(req, 'id')) });
  },
);

/**
 * GET /api/admin/voiceover/scripts/:id/audio/export?token=…
 * All rendered clips as a zip, named by segment and timecode so they drop
 * straight onto an editing timeline.
 */
voiceoverRouter.get(
  '/scripts/:id/audio/export',
  requireQueryToken,
  async (req: Request, res: Response) => {
    const script = await getScript(p(req, 'id'));
    if (!script) throw AppError.notFound('Script not found');

    const files = await listAudioFiles(script.id);
    if (files.length === 0) throw AppError.badRequest('No audio has been rendered for this script');

    const byIndex = new Map(script.segments.map((s) => [s.index, s]));
    const zip = new AdmZip();
    for (const file of files) {
      if (!fs.existsSync(file.storagePath)) continue;

      // The stitched track has no segment of its own; name it for what it is so
      // the zip reads as "one track plus the takes that built it".
      if (file.segmentIndex === TIMELINE_INDEX) {
        zip.addFile('full-timeline-track.mp3', fs.readFileSync(file.storagePath));
        continue;
      }

      const segment = byIndex.get(file.segmentIndex);
      const stamp = segment ? `${timecode(segment.startSec).replace(':', 'm')}s` : 'unknown';
      zip.addFile(
        `lines/${String(file.segmentIndex).padStart(2, '0')}-${stamp}.mp3`,
        fs.readFileSync(file.storagePath),
      );
    }

    const buffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeSlug(script.videoName)}-${script.tone}-audio.zip"`,
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  },
);

/**
 * PATCH /api/admin/voiceover/scripts/:id/segments/:index — hand-edit a line.
 * Body: { script }
 *
 * Any rendered audio for that line is discarded: the clip would otherwise say
 * something the script no longer does, which is worse than having no clip.
 */
voiceoverRouter.patch(
  '/scripts/:id/segments/:index',
  requireBearer,
  async (req: Request, res: Response) => {
    const scriptId = p(req, 'id');
    const index = Number.parseInt(p(req, 'index'), 10);
    if (!Number.isFinite(index)) throw AppError.badRequest('A segment index is required');

    const body = req.body as Record<string, unknown>;
    const text = typeof body['script'] === 'string' ? body['script'] : '';
    if (!text.trim()) throw AppError.badRequest('Narration text cannot be empty');
    if (text.length > 4000) throw AppError.badRequest('That line is too long (4000 characters max)');

    const segment = await updateSegmentText(scriptId, index, text);
    if (!segment) throw AppError.notFound('Segment not found');

    await deleteClip(scriptId, index);
    // The stitched track no longer reflects the script either.
    await deleteClip(scriptId, TIMELINE_INDEX);

    res.json({ segment });
  },
);

/**
 * POST /api/admin/voiceover/tts/sample — hear a voice before committing.
 * Body: { voiceId, modelId?, text? }
 *
 * Deliberately short and not stored: this is a listening test, not an asset.
 */
voiceoverRouter.post('/tts/sample', requireBearer, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const voiceId = typeof body['voiceId'] === 'string' ? body['voiceId'].trim() : '';
  if (!voiceId) throw AppError.badRequest('voiceId is required');

  const modelId =
    typeof body['modelId'] === 'string' && body['modelId'].trim()
      ? body['modelId'].trim()
      : DEFAULT_TTS_MODEL;
  const raw = typeof body['text'] === 'string' ? body['text'].trim() : '';
  const text = (raw || 'This is how the narration will sound for your walkthrough.').slice(0, 300);

  const key = await requireTtsKey();
  try {
    const clip = await renderClip(key, text, voiceId, modelId);
    const buffer = fs.readFileSync(clip.storagePath);
    // Not an asset — remove the file once it has been streamed back.
    removeClipFile(clip.storagePath);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
  } catch (err) {
    throw AppError.badRequest((err as Error).message);
  }
});

/**
 * POST /api/admin/voiceover/scripts/:id/audio/timeline — one full-length track.
 *
 * Each rendered line is delayed to its own timecode and the mix is padded to the
 * video's length, so the result drops under the video and lines up without
 * nudging. Per-line clips stay available for re-recording.
 */
voiceoverRouter.post(
  '/scripts/:id/audio/timeline',
  requireBearer,
  async (req: Request, res: Response) => {
    const script = await getScript(p(req, 'id'));
    if (!script) throw AppError.notFound('Script not found');
    if (script.durationSec <= 0) {
      throw AppError.badRequest('This script has no recorded video length to match.');
    }

    const files = await listAudioFiles(script.id, 'segment');
    if (files.length === 0) {
      throw AppError.badRequest('Render the individual lines first, then assemble the track.');
    }

    const startByIndex = new Map(script.segments.map((s) => [s.index, s.startSec]));
    const clips = files
      .map((f) => ({ startSec: startByIndex.get(f.segmentIndex) ?? 0, storagePath: f.storagePath }))
      .sort((a, b) => a.startSec - b.startSec);

    const existing = await listAudio(script.id);
    const voice = existing.find((c) => c.kind === 'segment');

    try {
      const built = await buildTimeline({ clips, durationSec: script.durationSec });
      const saved = await saveClip(
        script.id,
        TIMELINE_INDEX,
        {
          voiceId: voice?.voiceId ?? 'mixed',
          voiceName: voice?.voiceName ?? 'mixed',
          modelId: voice?.modelId ?? DEFAULT_TTS_MODEL,
        },
        built,
        'timeline',
      );
      res.json({ clip: saved, lines: clips.length });
    } catch (err) {
      throw AppError.badRequest((err as Error).message);
    }
  },
);
