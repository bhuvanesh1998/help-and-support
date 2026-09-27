/**
 * tts.service.ts — ElevenLabs narration audio.
 * ────────────────────────────────────────────
 * One request per segment, deliberately: a bad line is then a single re-render
 * rather than a full regeneration, and each clip drops onto its own mark on the
 * editing timeline.
 *
 * The key lives in the same encrypted credential store as the vision providers
 * (under `elevenlabs`), so it is never held in an environment variable and never
 * returned to a client.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { uploadDir } from '../../lib/upload.js';

const API_BASE = 'https://api.elevenlabs.io/v1';

/** Provider key under which the ElevenLabs credential is stored. */
export const TTS_PROVIDER = 'elevenlabs';

/** Default model. Overridable per request so a newer one needs no redeploy. */
export const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';

export interface Voice {
  voiceId: string;
  name: string;
  category: string | null;
  previewUrl: string | null;
}

export interface RenderedClip {
  filename: string;
  storagePath: string;
  publicUrl: string;
  sizeBytes: number;
}

function headers(apiKey: string): Record<string, string> {
  return { 'xi-api-key': apiKey };
}

/** Cheap credential check — the voices endpoint requires a valid key. */
export async function validateKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`${API_BASE}/voices`, { headers: headers(apiKey) });
    if (resp.ok) return { ok: true };
    if (resp.status === 401) {
      return { ok: false, error: 'ElevenLabs rejected this key (401 Unauthorized).' };
    }
    return { ok: false, error: `ElevenLabs returned HTTP ${resp.status} while validating.` };
  } catch (err) {
    return { ok: false, error: `Could not reach ElevenLabs: ${(err as Error).message}` };
  }
}

/** Voices available to the connected account. */
export async function listVoices(apiKey: string): Promise<Voice[]> {
  const resp = await fetch(`${API_BASE}/voices`, { headers: headers(apiKey) });
  if (!resp.ok) {
    throw new Error(`ElevenLabs ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    voices?: Array<{
      voice_id?: string;
      name?: string;
      category?: string;
      preview_url?: string;
    }>;
  };
  return (data.voices ?? [])
    .filter((v) => v.voice_id)
    .map((v) => ({
      voiceId: v.voice_id!,
      name: v.name ?? 'Unnamed voice',
      category: v.category ?? null,
      previewUrl: v.preview_url ?? null,
    }));
}

/** Models the account can use for text-to-speech. */
export async function listModels(apiKey: string): Promise<string[]> {
  const resp = await fetch(`${API_BASE}/models`, { headers: headers(apiKey) });
  if (!resp.ok) {
    throw new Error(`ElevenLabs ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as Array<{ model_id?: string; can_do_text_to_speech?: boolean }>;
  return (Array.isArray(data) ? data : [])
    .filter((m) => m.model_id && m.can_do_text_to_speech !== false)
    .map((m) => m.model_id!)
    .sort();
}

/**
 * Render one line and write it under the uploads directory, so the browser can
 * stream it back from the same static path the frame stills use.
 */
export async function renderClip(
  apiKey: string,
  text: string,
  voiceId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<RenderedClip> {
  const resp = await fetch(`${API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: { ...headers(apiKey), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: modelId }),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`ElevenLabs ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length === 0) throw new Error('ElevenLabs returned an empty audio response.');

  const filename = `${randomUUID()}.mp3`;
  const storagePath = path.join(uploadDir, filename);
  fs.writeFileSync(storagePath, buffer);

  return {
    filename,
    storagePath,
    publicUrl: `${env.publicBaseUrl}/uploads/${filename}`,
    sizeBytes: buffer.length,
  };
}

/** Remove a clip's file. Best effort: a missing file is not an error. */
export function removeClipFile(storagePath: string): void {
  try {
    if (fs.existsSync(storagePath)) fs.unlinkSync(storagePath);
  } catch {
    /* the DB row is the source of truth; a stray file is harmless */
  }
}
