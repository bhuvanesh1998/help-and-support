/**
 * credential.service.ts — Stored AI provider key (Anthropic).
 * ────────────────────────────────────────────────────────────
 * The admin connects a Claude key once; it is validated against Anthropic,
 * encrypted, and persisted. Every pipeline run then reuses it with no further
 * key entry. The plaintext key never leaves the server and is never returned
 * to clients — only a masked last-4 preview and metadata are exposed.
 */

import { prisma } from '../../lib/prisma.js';
import { seal, open } from '../../lib/crypto.js';

const PROVIDER = 'anthropic';

export interface CredentialStatus {
  connected: boolean;
  keyLast4: string | null;
  model: string | null;
  validatedAt: string | null;
  updatedAt: string | null;
}

const DISCONNECTED: CredentialStatus = {
  connected: false,
  keyLast4: null,
  model: null,
  validatedAt: null,
  updatedAt: null,
};

export async function getCredentialStatus(): Promise<CredentialStatus> {
  const row = await prisma.aiCredential.findUnique({ where: { provider: PROVIDER } });
  if (!row) return DISCONNECTED;
  return {
    connected: true,
    keyLast4: row.keyLast4,
    model: row.model,
    validatedAt: row.validatedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Returns the decrypted key + stored default model, or null if none is set. */
export async function getDecryptedKey(): Promise<{ key: string; model: string } | null> {
  const row = await prisma.aiCredential.findUnique({ where: { provider: PROVIDER } });
  if (!row) return null;
  try {
    const key = open({ ciphertext: row.encryptedKey, iv: row.iv, authTag: row.authTag });
    return { key, model: row.model };
  } catch {
    // Encryption secret changed since this was stored — treat as not set.
    return null;
  }
}

/** Cheap, no-token validation: the Models endpoint requires a valid key. */
export async function validateAnthropicKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 401) return { ok: false, error: 'Anthropic rejected this key (401 Unauthorized). Check it and try again.' };
    if (resp.status === 403) return { ok: false, error: 'This key is valid but lacks API access (403 Forbidden).' };
    return { ok: false, error: `Anthropic returned HTTP ${resp.status} while validating the key.` };
  } catch (err) {
    return { ok: false, error: `Could not reach Anthropic: ${(err as Error).message}` };
  }
}

export async function saveCredential(
  key: string,
  model: string,
  userId: string,
): Promise<CredentialStatus> {
  const sealed = seal(key);
  const keyLast4 = key.slice(-4);
  const data = {
    encryptedKey: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    keyLast4,
    model,
    validatedAt: new Date(),
    updatedById: userId,
  };
  await prisma.aiCredential.upsert({
    where: { provider: PROVIDER },
    update: data,
    create: { provider: PROVIDER, ...data },
  });
  return getCredentialStatus();
}

export async function deleteCredential(): Promise<void> {
  await prisma.aiCredential.deleteMany({ where: { provider: PROVIDER } });
}
