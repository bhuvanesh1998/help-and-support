/**
 * mcp.routes.ts — Streamable-HTTP MCP transport endpoint.
 *
 * Mounted at `/mcp`, BEFORE the global admin JWT middleware. A Claude host
 * authenticates with the connector bearer token (NOT a JWT). Runs in stateless
 * mode: a fresh McpServer + transport per request.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from '../services/mcp/mcp-server.js';
import { verifyToken } from '../services/mcp/connector.service.js';
import { logger } from '../lib/logger.js';

export const mcpRouter: Router = Router();

function bearer(req: Request): string {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  // Some hosts pass the token as ?token= or x-api-key.
  const q = req.query['token'];
  if (typeof q === 'string') return q;
  const k = req.headers['x-api-key'];
  if (typeof k === 'string') return k;
  return '';
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : -32600, message },
    id: null,
  });
}

mcpRouter.post('/', async (req: Request, res: Response) => {
  if (!(await verifyToken(bearer(req)))) {
    jsonRpcError(res, 401, 'Invalid or missing MCP connector token');
    return;
  }

  // Stateless: a brand-new server + transport per request, torn down on close.
  // userId is null — MCP requests authenticate via the connector token, not an admin user.
  const server = buildMcpServer(null);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error('mcp request failed', { error: (err as Error).message });
    if (!res.headersSent) jsonRpcError(res, 500, 'Internal MCP server error');
  }
});

// Stateless mode has no server-initiated stream or session to delete.
mcpRouter.get('/', (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed — this MCP server is stateless (POST only).' },
    id: null,
  });
});

mcpRouter.delete('/', (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
});
