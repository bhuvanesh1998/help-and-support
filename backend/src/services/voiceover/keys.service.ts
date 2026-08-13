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
import { TTS_PROVIDER, validateKey as validateTtsKey } from './tts.service.js';

/**
 * Credentials this feature stores. The vision providers write the script; the
 * text-to-speech provider renders it. They share one table because they share
 * one lifecycle: connect once, encrypted at rest, never read back.
 */
export type CredentialId = ProviderId | typeof TTS_PROVIDER;

const ALL_CREDENTIALS: CredentialId[] = [...PROVIDERS, TTS_PROVIDER];

export function isCredentialId(value: unknown): value is CredentialId {
  return typeof value === 'string' && (ALL_CREDENTIALS as string[]).includes(value);
}

/** Metadata for credentials that are not vision providers. */
const TTS_META = {
  label: 'ElevenLabs (text to speech)',
  defaultModel: 'eleven_multilingual_v2',
  suggestedModels: ['eleven_multilingual_v2'],
  keyHint: 'ElevenLabs API key',
};

export interface KeyStatus {
  provider: CredentialId;
  label: string;
  connected: boolean;
  keyLast4: string | null;
  validatedAt: string | null;
  keyHint: string;
  suggestedModels: string[];
  defaultModel: string;
}

/** Connection status for every credential, for the settings UI. */
export async function listKeyStatus(): Promise<KeyStatus[]> {
  const rows = await prisma.aiCredential.findMany({
    where: { provider: { in: ALL_CREDENTIALS } },
  });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  return ALL_CREDENTIALS.map((provider) => {
    const row = byProvider.get(provider);
    const meta = provider === TTS_PROVIDER ? TTS_META : PROVIDER_META[provider as ProviderId];
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

/** Decrypted key for one credential, or null when not connected. */
export async function getKey(provider: CredentialId): Promise<string | null> {
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
  provider: CredentialId,
  key: string,
  userId: string,
): Promise<{ ok: boolean; error?: string; status?: KeyStatus[] }> {
  const check =
    provider === TTS_PROVIDER
      ? await validateTtsKey(key)
      : await getProvider(provider).validateKey(key);
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
    create: {
      provider,
      ...data,
      model:
        provider === TTS_PROVIDER ? TTS_META.defaultModel : PROVIDER_META[provider].defaultModel,
    },
  });

  return { ok: true, status: await listKeyStatus() };
}

export async function deleteKey(provider: CredentialId): Promise<KeyStatus[]> {
  await prisma.aiCredential.deleteMany({ where: { provider } });
  return listKeyStatus();
}
