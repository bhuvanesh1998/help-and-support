/**
 * connector.routes.ts — HTTP bridge for the browser-extension connector.
 * ───────────────────────────────────────────────────────────────────────────
 * Mounted at `/connector`, BEFORE the admin JWT middleware. The extension
 * authenticates with the same MCP connector bearer token. Transport only — it
 * carries commands (Claude → extension) and results/events (extension → server)
 * over the in-memory bridge. No browser data is persisted here; the MCP tools do
 * that when they consume a command's result.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/mcp/connector.service.js';
import {
  addApiCalls,
  disconnect,
  hasSession,
  nextCommand,
  registerSession,
  resolveResult,
  touch,
} from '../services/connector/bridge.js';

export const connectorRouter: Router = Router();

function bearer(req: Request): string {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const k = req.headers['x-api-key'];
  return typeof k === 'string' ? k : '';
}

// Gate every route on the connector token.
connectorRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  if (await verifyToken(bearer(req))) return next();
  res.status(401).json({ error: { message: 'Invalid or missing connector token', code: 'UNAUTHORIZED' } });
});

/** POST /connector/register → { sessionId } */
connectorRouter.post('/register', (req: Request, res: Response) => {
  const label = typeof req.body?.label === 'string' ? req.body.label : 'browser';
  const sessionId = registerSession(label);
  res.json({ sessionId });
});

/** GET /connector/poll?sessionId=… — long-poll for the next command. */
connectorRouter.get('/poll', async (req: Request, res: Response) => {
  const sessionId = String(req.query['sessionId'] ?? '');
  const url = typeof req.query['url'] === 'string' ? req.query['url'] : undefined;
  // Session pruned (TTL) or the worker restarted with a stale id → tell the
  // extension to re-register so the connection self-heals without a manual click.
  if (!hasSession(sessionId)) {
    res.json({ expired: true });
    return;
  }
  touch(sessionId, url ?? null);
  const command = await nextCommand(sessionId);
  res.json({ command });
});

/** POST /connector/result — extension returns a command's result. */
connectorRouter.post('/result', (req: Request, res: Response) => {
  const { commandId, ok, data, error } = req.body as {
    commandId?: string;
    ok?: boolean;
    data?: unknown;
    error?: string;
  };
  if (!commandId) {
    res.status(400).json({ error: { message: 'commandId required' } });
    return;
  }
  resolveResult(commandId, ok !== false, data, error);
  res.status(204).send();
});

/** POST /connector/events — extension pushes captured network/route data. */
connectorRouter.post('/events', async (req: Request, res: Response) => {
  const { sessionId, url, apiCalls } = req.body as {
    sessionId?: string;
    url?: string;
    apiCalls?: unknown;
  };
  if (sessionId) {
    touch(sessionId, url ?? null);
    if (Array.isArray(apiCalls) && apiCalls.length) addApiCalls(sessionId, apiCalls);
  }
  res.status(204).send();
});

/** POST /connector/disconnect */
connectorRouter.post('/disconnect', (req: Request, res: Response) => {
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  disconnect(sessionId);
  res.status(204).send();
});
