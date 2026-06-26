/**
 * mcp-admin.routes.ts — Manage the MCP connector from the admin UI.
 * Mounted under /api/admin/mcp (JWT-protected). Drives the "Claude MCP Connect" screen.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import {
  getStatus,
  generateToken,
  revealToken,
  setEnabled,
  revoke,
} from '../../services/mcp/connector.service.js';
import { MCP_TOOLS, recentCalls } from '../../services/mcp/mcp-server.js';
import { buildExtensionZip, extensionExists } from '../../services/connector/extension-pack.js';
import { AppError } from '../../utils/app-error.js';

export const mcpAdminRouter: Router = Router();

function serverUrl(): string {
  return `${env.publicBaseUrl}/mcp`;
}

/** GET /api/admin/mcp — status, tool list, recent calls (no token). */
mcpAdminRouter.get('/', async (_req: Request, res: Response) => {
  const status = await getStatus();
  res.json({
    ...status,
    serverUrl: serverUrl(),
    tools: MCP_TOOLS,
    recentCalls: recentCalls().slice(0, 25),
  });
});

/** GET /api/admin/mcp/token — reveal the plaintext token for copy. */
mcpAdminRouter.get('/token', async (_req: Request, res: Response) => {
  const token = await revealToken();
  if (!token) throw AppError.notFound('No MCP token generated yet');
  res.json({ token });
});

/** POST /api/admin/mcp/token — generate or rotate the token. */
mcpAdminRouter.post('/token', async (req: Request, res: Response) => {
  const { token, status } = await generateToken(req.user!.id);
  res.status(201).json({ token, ...status });
});

/** PATCH /api/admin/mcp — enable/disable the connector. */
mcpAdminRouter.patch('/', async (req: Request, res: Response) => {
  const body = req.body as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') throw AppError.badRequest('enabled (boolean) is required');
  const status = await setEnabled(body.enabled);
  res.json(status);
});

/** DELETE /api/admin/mcp — revoke the token entirely. */
mcpAdminRouter.delete('/', async (_req: Request, res: Response) => {
  await revoke();
  res.json({ revoked: true });
});

/** GET /api/admin/mcp/extension — download the browser-extension as a .zip. */
mcpAdminRouter.get('/extension', (_req: Request, res: Response) => {
  if (!extensionExists()) throw AppError.notFound('Extension files not found on the server');
  const zip = buildExtensionZip();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="helpassistant-connector.zip"');
  res.setHeader('Content-Length', String(zip.length));
  res.end(zip);
});
