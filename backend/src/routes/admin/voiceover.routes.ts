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
import { getKey, listKeyStatus, saveKey, deleteKey } from '../../services/voiceover/keys.service.js';
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
  if (!isProviderId(provider)) throw AppError.badRequest('Unknown provider');

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
  if (!isProviderId(provider)) throw AppError.badRequest('Unknown provider');
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

// ── Export ───────────────────────────────────────────────────────────────────

function safeSlug(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9\-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'voiceover'
  );
}

/** The human-facing reference doc: timecodes, on-screen action, VO, budget. */
function buildScriptMarkdown(
  appName: string,
  videoName: string,
  segments: VoSegment[],
  wordsPerMinute: number,
): string {
  const totalWords = segments.reduce((sum, s) => sum + s.wordCount, 0);
  const over = segments.filter((s) => s.wordCount > s.wordBudget);

  const rows = segments
    .map((s) => {
      const flag = s.wordCount > s.wordBudget ? ' ⚠️' : '';
      const onScreen = s.onScreen.replace(/\|/g, '\\|');
      const script = s.script.replace(/\|/g, '\\|');
      return `| ${s.index} | ${timecode(s.startSec)}–${timecode(s.endSec)} | ${(
        s.endSec - s.startSec
      ).toFixed(1)}s | ${onScreen} | ${script} | ${s.wordCount}/${s.wordBudget}${flag} |`;
    })
    .join('\n');

  return `# Voiceover script — ${appName}

**Source video:** ${videoName}
**Segments:** ${segments.length}
**Total words:** ${totalWords} (~${Math.round((totalWords / wordsPerMinute) * 60)}s spoken at ${wordsPerMinute} wpm)
${over.length ? `**Over budget:** ${over.length} segment(s) marked ⚠️ — trim before recording.\n` : ''}
> Timecodes are for your editing timeline only. Do **not** paste this file into a
> text-to-speech engine — it will read the numbers aloud. Use the clean
> per-segment files in \`segments/\` for that.

| # | In–Out | Length | On screen | Voiceover | Words |
|---|--------|--------|-----------|-----------|-------|
${rows}
`;
}

/**
 * GET /api/admin/voiceover/jobs/:id/export?token=…
 * Returns a zip: the timed script plus one clean TTS-ready file per segment.
 */
voiceoverRouter.get('/jobs/:id/export', requireQueryToken, (req: Request, res: Response) => {
  const job = ownedJob(req);
  if (job.segments.length === 0) throw AppError.badRequest('This job has no segments yet');

  const slug = safeSlug(job.config.videoName);
  const zip = new AdmZip();

  zip.addFile(
    'voiceover-script.md',
    Buffer.from(
      buildScriptMarkdown(
        job.config.appName,
        job.config.videoName,
        job.segments,
        job.settings.wordsPerMinute,
      ),
      'utf8',
    ),
  );

  for (const s of job.segments) {
    const name = `segments/${String(s.index).padStart(2, '0')}.txt`;
    zip.addFile(name, Buffer.from(`${s.script}\n`, 'utf8'));
  }

  // A single combined read-through, for anyone who wants one continuous take.
  zip.addFile(
    'segments/all-segments.txt',
    Buffer.from(`${job.segments.map((s) => s.script).join('\n\n')}\n`, 'utf8'),
  );

  const buffer = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-voiceover.zip"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
});
