/**
 * ai-pipeline.routes.ts — Drive the scrape → AI-draft flow from the admin UI.
 *
 * Mounted BEFORE the global `authenticate` middleware because the SSE stream
 * endpoint cannot send an Authorization header (EventSource limitation) and
 * authenticates via a `?token=` query param instead. All other routes still
 * require a Bearer token.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { parseAccessToken } from '../../middleware/auth.middleware.js';
import { AppError } from '../../utils/app-error.js';
import {
  startJob,
  cancelJob,
  getJob,
  snapshot,
  subscribe,
  unsubscribe,
} from '../../services/ai-pipeline/job-manager.js';
import type { SessionInjection } from '../../services/ai-pipeline/types.js';
import {
  getCredentialStatus,
  getDecryptedKey,
  saveCredential,
  deleteCredential,
  validateAnthropicKey,
} from '../../services/ai-pipeline/credential.service.js';

export const aiPipelineRouter: Router = Router();

const ANTHROPIC_MODELS = new Set([
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
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

/** Query-token auth for the SSE stream (EventSource can't set headers). */
function requireQueryToken(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.query['token'];
  const token = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0]) : '';
  if (!token) throw AppError.unauthorized('Missing token');
  const payload = parseAccessToken(token);
  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
}

/**
 * POST /api/admin/ai-pipeline/jobs
 * Body: { baseUrl, appName, email, password, anthropicKey, model?, navDepth? }
 * Starts a job and returns its id. Secrets are held in memory only.
 */
aiPipelineRouter.post('/jobs', requireBearer, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const baseUrlRaw = typeof body['baseUrl'] === 'string' ? body['baseUrl'].trim() : '';
  if (!baseUrlRaw) throw AppError.badRequest('baseUrl is required');

  let baseUrl: string;
  try {
    const u = new URL(baseUrlRaw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    baseUrl = `${u.protocol}//${u.host}`;
  } catch {
    throw AppError.badRequest('baseUrl must be a valid http(s) URL');
  }

  // Model: honour an explicit valid choice, else fall through to the stored default.
  const clientModelRaw = typeof body['model'] === 'string' ? body['model'] : '';
  const clientModel = ANTHROPIC_MODELS.has(clientModelRaw) ? clientModelRaw : '';

  // Key: an explicit per-run key wins; otherwise use the stored, connected key.
  let anthropicKey = typeof body['anthropicKey'] === 'string' ? body['anthropicKey'].trim() : '';
  let model = clientModel || 'claude-sonnet-4-6';

  if (!anthropicKey) {
    const stored = await getDecryptedKey();
    if (!stored) {
      throw AppError.badRequest(
        'No Claude key available. Connect your Claude account in the AI Pipeline first.',
      );
    }
    anthropicKey = stored.key;
    if (!clientModel) model = stored.model;
  }

  const email = typeof body['email'] === 'string' ? body['email'].trim() : '';
  const password = typeof body['password'] === 'string' ? body['password'] : '';

  const navDepthRaw = Number(body['navDepth'] ?? 1);
  const navDepth = Math.min(3, Math.max(0, Number.isFinite(navDepthRaw) ? navDepthRaw : 1));

  const appName =
    typeof body['appName'] === 'string' && body['appName'].trim()
      ? body['appName'].trim()
      : new URL(baseUrl).hostname;

  const headed = body['headed'] === true;

  // Optional pre-authenticated session (treated as a secret).
  let session: SessionInjection | undefined;
  const rawSession = body['session'];
  if (rawSession && typeof rawSession === 'object') {
    const s = rawSession as Record<string, unknown>;
    const cookies = Array.isArray(s['cookies'])
      ? (s['cookies'] as SessionInjection['cookies'])
      : undefined;
    const ls =
      s['localStorage'] && typeof s['localStorage'] === 'object'
        ? (s['localStorage'] as Record<string, string>)
        : undefined;
    const startPath = typeof s['startPath'] === 'string' ? s['startPath'] : undefined;
    if (cookies?.length || (ls && Object.keys(ls).length)) {
      session = { cookies, localStorage: ls, startPath };
    }
  }

  const id = startJob({
    userId: req.user!.id,
    baseUrl,
    appName,
    email,
    password,
    anthropicKey,
    model,
    navDepth,
    headed,
    session,
  });

  res.status(201).json({ jobId: id });
});

// ── Stored credential (connect once, reuse for every run) ────────────────────

/** GET /api/admin/ai-pipeline/credential — connection status (never the key). */
aiPipelineRouter.get('/credential', requireBearer, async (_req: Request, res: Response) => {
  res.json(await getCredentialStatus());
});

/**
 * PUT /api/admin/ai-pipeline/credential
 * Body: { anthropicKey, model? } — validates against Anthropic, then stores
 * the key encrypted. Returns the (masked) status.
 */
aiPipelineRouter.put('/credential', requireBearer, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const key = typeof body['anthropicKey'] === 'string' ? body['anthropicKey'].trim() : '';
  if (!key) throw AppError.badRequest('anthropicKey is required');

  const modelRaw = typeof body['model'] === 'string' ? body['model'] : 'claude-sonnet-4-6';
  const model = ANTHROPIC_MODELS.has(modelRaw) ? modelRaw : 'claude-sonnet-4-6';

  const check = await validateAnthropicKey(key);
  if (!check.ok) throw AppError.badRequest(check.error ?? 'Key validation failed');

  const status = await saveCredential(key, model, req.user!.id);
  res.json(status);
});

/** DELETE /api/admin/ai-pipeline/credential — disconnect (removes the key). */
aiPipelineRouter.delete('/credential', requireBearer, async (_req: Request, res: Response) => {
  await deleteCredential();
  res.json({ disconnected: true });
});

/** GET /api/admin/ai-pipeline/jobs/:id — current snapshot (polling / reconnect). */
aiPipelineRouter.get('/jobs/:id', requireBearer, (req: Request, res: Response) => {
  const job = getJob(p(req, 'id'));
  if (!job) throw AppError.notFound('Job not found or expired');
  res.json(snapshot(job));
});

/** POST /api/admin/ai-pipeline/jobs/:id/cancel */
aiPipelineRouter.post('/jobs/:id/cancel', requireBearer, (req: Request, res: Response) => {
  const ok = cancelJob(p(req, 'id'));
  if (!ok) throw AppError.badRequest('Job not found or already finished');
  res.json({ cancelled: true });
});

/** GET /api/admin/ai-pipeline/jobs/:id/stream?token=... — SSE progress stream. */
aiPipelineRouter.get('/jobs/:id/stream', requireQueryToken, (req: Request, res: Response) => {
  const job = getJob(p(req, 'id'));
  if (!job) throw AppError.notFound('Job not found or expired');

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
      /* closed */
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe(job, res);
  });
});
