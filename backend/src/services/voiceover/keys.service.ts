/**
 * keys.service.ts — Provider API keys (Anthropic / OpenAI / Gemini).
 * ──────────────────────────────────────────────────────────────────
 * Reuses the existing `ai_credentials` table, whose `provider` column is
 * already unique — so the Anthropic row is shared with the AI Pipeline
 * (connect once, both features use it) and the other providers simply add
 * rows alongside it.
 *
 * Keys are validated against the provider, encrypted at rest, and never
 * returned to a client: only a masked last-4 preview and metadata are exposed.
 */

import { prisma } from '../../lib/prisma.js';
import { seal, open } from '../../lib/crypto.js';
import { getProvider, PROVIDER_META, PROVIDERS, type ProviderId } from './providers/index.js';

export interface KeyStatus {
  provider: ProviderId;
  label: string;
  connected: boolean;
  keyLast4: string | null;
  validatedAt: string | null;
  keyHint: string;
  suggestedModels: string[];
  defaultModel: string;
}

/** Connection status for every provider, for the settings UI. */
export async function listKeyStatus(): Promise<KeyStatus[]> {
  const rows = await prisma.aiCredential.findMany({
    where: { provider: { in: [...PROVIDERS] } },
  });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  return PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    const meta = PROVIDER_META[provider];
    return {
      provider,
      label: meta.label,
      connected: !!row,
      keyLast4: row?.keyLast4 ?? null,
      validatedAt: row?.validatedAt?.toISOString() ?? null,
      keyHint: meta.keyHint,
      suggestedModels: meta.suggestedModels,
      defaultModel: meta.defaultModel,
    };
  });
}

/** Decrypted key for one provider, or null when not connected. */
export async function getKey(provider: ProviderId): Promise<string | null> {
  const row = await prisma.aiCredential.findUnique({ where: { provider } });
  if (!row) return null;
  try {
    return open({ ciphertext: row.encryptedKey, iv: row.iv, authTag: row.authTag });
  } catch {
    // Encryption secret changed since this was stored — treat as not set.
    return null;
  }
}

/** Validate against the provider, then persist encrypted. */
export async function saveKey(
  provider: ProviderId,
  key: string,
  userId: string,
): Promise<{ ok: boolean; error?: string; status?: KeyStatus[] }> {
  const check = await getProvider(provider).validateKey(key);
  if (!check.ok) return { ok: false, error: check.error };

  const sealed = seal(key);
  const data = {
    encryptedKey: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    keyLast4: key.slice(-4),
    validatedAt: new Date(),
    updatedById: userId,
  };

  await prisma.aiCredential.upsert({
    where: { provider },
    // `model` is owned by the AI Pipeline for the anthropic row; the voiceover
    // feature keeps its own model in its settings, so it is only set on create.
    update: data,
    create: { provider, ...data, model: PROVIDER_META[provider].defaultModel },
  });

  return { ok: true, status: await listKeyStatus() };
}

export async function deleteKey(provider: ProviderId): Promise<KeyStatus[]> {
  await prisma.aiCredential.deleteMany({ where: { provider } });
  return listKeyStatus();
}
