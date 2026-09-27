/**
 * gemini.provider.ts — Gemini vision via the Generative Language API.
 *
 * Images travel as `inline_data` parts. Structured output is requested with
 * `responseMimeType: application/json` plus a `responseSchema`, which accepts
 * only an OpenAPI subset — hence the reduced schema (no additionalProperties).
 */

import {
  GEMINI_SEGMENT_SCHEMA,
  parseSegments,
  providerError,
  type ProviderRequest,
  type ProviderResult,
  type VisionProvider,
} from './types.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** The key travels as a header rather than a query param so it stays out of logs. */
function authHeaders(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
}

export const geminiProvider: VisionProvider = {
  id: 'gemini',

  async generate(req): Promise<ProviderResult> {
    const parts: unknown[] = [{ text: req.prompt }];
    for (const frame of req.frames) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: frame.base64 } });
    }

    const resp = await fetch(
      `${API_BASE}/models/${encodeURIComponent(req.model)}:generateContent`,
      {
        method: 'POST',
        headers: authHeaders(req.apiKey),
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SEGMENT_SCHEMA,
            maxOutputTokens: req.maxTokens,
          },
        }),
        signal: req.signal,
      },
    );

    if (!resp.ok) {
      throw providerError('Gemini', resp.status, await resp.text());
    }

    const data = (await resp.json()) as {
      promptFeedback?: { blockReason?: string };
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const usage = {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };

    // Safety blocks surface either on the prompt or as a candidate finishReason.
    if (data.promptFeedback?.blockReason) return { segments: [], refused: true, usage };
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
      return { segments: [], refused: true, usage };
    }

    // Gemini 3 models can return reasoning parts alongside the answer; those
    // are flagged `thought` and would corrupt the JSON if concatenated.
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    return { segments: parseSegments(text), refused: false, usage };
  },

  async listModels(apiKey) {
    const resp = await fetch(`${API_BASE}/models?pageSize=200`, { headers: authHeaders(apiKey) });
    if (!resp.ok) {
      throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = (await resp.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    return (data.models ?? [])
      .filter((m) => m.name && m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name!.replace(/^models\//, ''))
      // Image/audio/video generators and robotics models cannot write a script.
      .filter((id) => !/-(image|tts|clip)(-|$)|^lyria|^nano-banana|robotics/.test(id))
      .sort();
  },

  async validateKey(apiKey) {
    try {
      const resp = await fetch(`${API_BASE}/models`, { headers: authHeaders(apiKey) });
      if (resp.ok) return { ok: true };
      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        return { ok: false, error: `Google rejected this key (HTTP ${resp.status}).` };
      }
      return { ok: false, error: `Google returned HTTP ${resp.status} while validating.` };
    } catch (err) {
      return { ok: false, error: `Could not reach Google: ${(err as Error).message}` };
    }
  },
};
