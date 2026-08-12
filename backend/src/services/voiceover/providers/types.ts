/**
 * providers/types.ts — Vision-provider contract for script generation.
 * ───────────────────────────────────────────────────────────────────
 * Each provider takes the same frames + prompt and returns the same segment
 * shape, so the rest of the pipeline is provider-agnostic. Adding a provider
 * means adding one adapter here, not touching the job manager.
 */

/** Providers that can read video frames and write the script. */
export const PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/** Human-facing provider metadata, surfaced in the settings UI. */
export const PROVIDER_META: Record<
  ProviderId,
  { label: string; defaultModel: string; suggestedModels: string[]; keyHint: string }
> = {
  anthropic: {
    label: 'Claude (Anthropic)',
    defaultModel: 'claude-opus-5',
    suggestedModels: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6'],
    keyHint: 'Starts with sk-ant-',
  },
  openai: {
    label: 'ChatGPT (OpenAI)',
    defaultModel: 'gpt-4o',
    suggestedModels: ['gpt-4o', 'gpt-4o-mini'],
    keyHint: 'Starts with sk-',
  },
  gemini: {
    label: 'Gemini (Google)',
    // Aliases rather than pinned versions: Google retires numbered Gemini
    // models quickly, and a pinned default silently 404s once it goes.
    defaultModel: 'gemini-flash-latest',
    suggestedModels: ['gemini-flash-latest', 'gemini-pro-latest'],
    keyHint: 'Google AI Studio API key',
  },
};

/** A frame ready to send: base64 JPEG plus its timestamp. */
export interface ProviderFrame {
  at: number;
  base64: string;
}

/** One segment as returned by a provider, before normalisation. */
export interface RawSegment {
  startSec?: number;
  endSec?: number;
  onScreen?: string;
  script?: string;
}

export interface ProviderRequest {
  apiKey: string;
  model: string;
  maxTokens: number;
  /** Reasoning depth. Only Anthropic consumes this today. */
  effort: string;
  frames: ProviderFrame[];
  prompt: string;
  signal: AbortSignal;
}

/** Tokens a provider reported for one call, when it reports them. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResult {
  segments: RawSegment[];
  /** True when the provider declined the request on policy grounds. */
  refused: boolean;
  /** Reported usage, for the usage report. Zeroed when a provider omits it. */
  usage: ProviderUsage;
}

export interface VisionProvider {
  id: ProviderId;
  /** Generate segments for one batch of frames. */
  generate(req: ProviderRequest): Promise<ProviderResult>;
  /** Cheap credential check — no generation, no tokens where possible. */
  validateKey(apiKey: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Models the account can actually use right now, asked of the provider.
   * Hardcoded lists rot — providers retire model IDs on their own schedule, and
   * a stale default fails with a bare 404 at generation time.
   */
  listModels(apiKey: string): Promise<string[]>;
}

/**
 * The segment schema, in strict JSON-Schema form. Anthropic and OpenAI both
 * accept this directly; Gemini needs the reduced variant below.
 */
export const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startSec: { type: 'number' },
          endSec: { type: 'number' },
          onScreen: { type: 'string' },
          script: { type: 'string' },
        },
        required: ['startSec', 'endSec', 'onScreen', 'script'],
        additionalProperties: false,
      },
    },
  },
  required: ['segments'],
  additionalProperties: false,
} as const;

/**
 * Gemini's responseSchema accepts only an OpenAPI subset — notably it rejects
 * `additionalProperties`, so the schema is declared separately rather than
 * stripped at runtime.
 */
export const GEMINI_SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startSec: { type: 'number' },
          endSec: { type: 'number' },
          onScreen: { type: 'string' },
          script: { type: 'string' },
        },
        required: ['startSec', 'endSec', 'onScreen', 'script'],
      },
    },
  },
  required: ['segments'],
} as const;

/**
 * Parse a provider's text response into segments. Providers are asked for
 * strict JSON, but a stray code fence still shows up occasionally, so the
 * fenced form is tolerated rather than failing the whole batch.
 */
export function parseSegments(text: string): RawSegment[] {
  const clean = text
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!clean) return [];

  try {
    const parsed = JSON.parse(clean) as { segments?: RawSegment[] };
    return parsed.segments ?? [];
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Unparseable response: ${clean.slice(0, 200)}`);
    const parsed = JSON.parse(match[0]) as { segments?: RawSegment[] };
    return parsed.segments ?? [];
  }
}

/** Shared error shape so the caller can retry without the fallback opt-in. */
export interface ProviderError extends Error {
  fallbackRejected?: boolean;
  /** HTTP status from the provider, when the failure was a response. */
  status?: number;
}

/**
 * Statuses worth retrying: rate limits, overload and transient server faults.
 * Free-tier accounts hit 429/503 routinely, and without a retry a single spike
 * throws away a whole job's worth of extracted frames.
 */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function isRetryable(err: unknown): boolean {
  const status = (err as ProviderError)?.status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  // Network-level failures (socket reset, DNS blip) carry no status.
  return /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(
    (err as Error)?.message ?? '',
  );
}

/** Build an error that carries the provider's HTTP status for retry decisions. */
export function providerError(label: string, status: number, body: string): ProviderError {
  const error: ProviderError = new Error(`${label} ${status}: ${body.slice(0, 300)}`);
  error.status = status;
  return error;
}
