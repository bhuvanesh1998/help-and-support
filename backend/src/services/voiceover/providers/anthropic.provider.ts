/**
 * anthropic.provider.ts — Claude vision via the Messages API.
 *
 * Raw HTTP rather than the SDK, matching how this codebase already talks to
 * Anthropic in ai-draft.service.ts.
 */

import {
  SEGMENT_SCHEMA,
  parseSegments,
  type ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type VisionProvider,
} from './types.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
const VERSION = '2023-06-01';
/** Server-side fallback: a policy decline is re-served by another model in-call. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

async function call(req: ProviderRequest, useFallback: boolean): Promise<ProviderResult> {
  const content: unknown[] = req.frames.map((f) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 },
  }));
  content.push({ type: 'text', text: req.prompt });

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: req.effort,
      format: { type: 'json_schema', schema: SEGMENT_SCHEMA },
    },
    messages: [{ role: 'user', content }],
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': req.apiKey,
    'anthropic-version': VERSION,
  };

  if (useFallback) {
    body['fallbacks'] = 'default';
    headers['anthropic-beta'] = FALLBACK_BETA;
  }

  const resp = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    const error: ProviderError = new Error(`Anthropic ${resp.status}: ${text.slice(0, 300)}`);
    // Lets the caller retry without the fallback opt-in if this org lacks the beta.
    error.fallbackRejected = useFallback && resp.status === 400 && /fallback|beta/i.test(text);
    throw error;
  }

  const data = (await resp.json()) as {
    stop_reason?: string;
    content?: Array<{ type?: string; text?: string }>;
  };

  // Check stop_reason before reading content: a refusal carries no usable text.
  if (data.stop_reason === 'refusal') return { segments: [], refused: true };

  const text = data.content?.find((b) => b.type === 'text')?.text ?? '';
  return { segments: parseSegments(text), refused: false };
}

export const anthropicProvider: VisionProvider = {
  id: 'anthropic',

  async generate(req) {
    try {
      return await call(req, true);
    } catch (err) {
      if ((err as ProviderError).fallbackRejected) return call(req, false);
      throw err;
    }
  },

  async validateKey(apiKey) {
    try {
      const resp = await fetch(MODELS_URL, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION },
      });
      if (resp.ok) return { ok: true };
      if (resp.status === 401) {
        return { ok: false, error: 'Anthropic rejected this key (401 Unauthorized).' };
      }
      if (resp.status === 403) {
        return { ok: false, error: 'This key is valid but lacks API access (403 Forbidden).' };
      }
      return { ok: false, error: `Anthropic returned HTTP ${resp.status} while validating.` };
    } catch (err) {
      return { ok: false, error: `Could not reach Anthropic: ${(err as Error).message}` };
    }
  },

  async listModels(apiKey) {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION },
    });
    if (!resp.ok) {
      throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((m) => m.id ?? '')
      .filter(Boolean)
      .sort();
  },
};
