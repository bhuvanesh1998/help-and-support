/**
 * connector.service.ts — Stored bearer token for the in-app MCP server.
 * ──────────────────────────────────────────────────────────────────────
 * A Claude host (Claude Code / Desktop / claude.ai connector) presents this
 * token as `Authorization: Bearer <token>` to reach `/mcp`. The token is
 * generated server-side, stored encrypted, and verified on every MCP request.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { seal, open } from '../../lib/crypto.js';

const NAME = 'default';

export interface ConnectorStatus {
  configured: boolean;
  enabled: boolean;
  tokenLast4: string | null;
  updatedAt: string | null;
}

function statusOf(row: {
  enabled: boolean;
  tokenLast4: string;
  updatedAt: Date;
} | null): ConnectorStatus {
  if (!row) return { configured: false, enabled: false, tokenLast4: null, updatedAt: null };
  return {
    configured: true,
    enabled: row.enabled,
    tokenLast4: row.tokenLast4,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getStatus(): Promise<ConnectorStatus> {
  const row = await prisma.mcpConnector.findUnique({ where: { name: NAME } });
  return statusOf(row);
}

/** Generate (or rotate) the token. Returns the plaintext ONCE for display. */
export async function generateToken(userId: string): Promise<{ token: string; status: ConnectorStatus }> {
  const token = `hamcp_${randomBytes(24).toString('base64url')}`;
  const sealed = seal(token);
  const tokenLast4 = token.slice(-4);
  const data = {
    encryptedToken: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    tokenLast4,
    enabled: true,
    updatedById: userId,
  };
  const row = await prisma.mcpConnector.upsert({
    where: { name: NAME },
    update: data,
    create: { name: NAME, ...data },
  });
  return { token, status: statusOf(row) };
}

/** Reveal the current plaintext token (admin-only endpoint). */
export async function revealToken(): Promise<string | null> {
  const row = await prisma.mcpConnector.findUnique({ where: { name: NAME } });
  if (!row) return null;
  try {
    return open({ ciphertext: row.encryptedToken, iv: row.iv, authTag: row.authTag });
  } catch {
    return null;
  }
}

export async function setEnabled(enabled: boolean): Promise<ConnectorStatus> {
  const row = await prisma.mcpConnector.update({ where: { name: NAME }, data: { enabled } });
  return statusOf(row);
}

export async function revoke(): Promise<void> {
  await prisma.mcpConnector.deleteMany({ where: { name: NAME } });
}

/** Constant-time check of a presented bearer token. */
export async function verifyToken(presented: string): Promise<boolean> {
  if (!presented) return false;
  const row = await prisma.mcpConnector.findUnique({ where: { name: NAME } });
  if (!row || !row.enabled) return false;
  let actual: string;
  try {
    actual = open({ ciphertext: row.encryptedToken, iv: row.iv, authTag: row.authTag });
  } catch {
    return false;
  }
  const a = Buffer.from(actual);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
