/**
 * openai.provider.ts — ChatGPT vision via the Chat Completions API.
 *
 * Images travel as `image_url` parts holding a data URL, and the response is
 * constrained with a strict `json_schema` response format so the reply parses
 * without guesswork.
 */

import {
  SEGMENT_SCHEMA,
  parseSegments,
  providerError,
  type ProviderRequest,
  type ProviderResult,
  type VisionProvider,
} from './types.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const MODELS_URL = 'https://api.openai.com/v1/models';

export const openaiProvider: VisionProvider = {
  id: 'openai',

  async generate(req): Promise<ProviderResult> {
    const content: unknown[] = [{ type: 'text', text: req.prompt }];
    for (const frame of req.frames) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${frame.base64}` },
      });
    }

    const resp = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        // `max_completion_tokens` is the current field; `max_tokens` is legacy.
        max_completion_tokens: req.maxTokens,
        messages: [{ role: 'user', content }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'voiceover_segments', strict: true, schema: SEGMENT_SCHEMA },
        },
      }),
      signal: req.signal,
    });

    if (!resp.ok) {
      throw providerError('OpenAI', resp.status, await resp.text());
    }

    const data = (await resp.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string | null; refusal?: string | null };
      }>;
    };

    const choice = data.choices?.[0];
    // A strict-schema refusal arrives as a populated `refusal` with null content.
    if (choice?.message?.refusal) return { segments: [], refused: true };

    return { segments: parseSegments(choice?.message?.content ?? ''), refused: false };
  },

  async validateKey(apiKey) {
    try {
      const resp = await fetch(MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (resp.ok) return { ok: true };
      if (resp.status === 401) {
        return { ok: false, error: 'OpenAI rejected this key (401 Unauthorized).' };
      }
      if (resp.status === 403) {
        return { ok: false, error: 'This key is valid but lacks API access (403 Forbidden).' };
      }
      return { ok: false, error: `OpenAI returned HTTP ${resp.status} while validating.` };
    } catch (err) {
      return { ok: false, error: `Could not reach OpenAI: ${(err as Error).message}` };
    }
  },

  async listModels(apiKey) {
    const resp = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!resp.ok) {
      throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((m) => m.id ?? '')
      // The account's model list includes embeddings, audio, image and moderation
      // models that cannot read a frame and return JSON.
      .filter((id) => /^(gpt|o[0-9]|chatgpt)/.test(id))
      .filter((id) => !/(embedding|whisper|tts|audio|realtime|image|dall-e|moderation|transcribe|search|instruct)/.test(id))
      .sort();
  },
};
