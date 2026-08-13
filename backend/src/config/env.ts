import 'dotenv/config';

/**
 * Centralised, validated environment access.
 * The process refuses to start if a required secret is missing — this prevents
 * silently falling back to insecure defaults in production.
 */

type NodeEnv = 'development' | 'test' | 'production';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value : fallback;
}

function intOf(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}".`);
  }
  return parsed;
}

function floatOf(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}".`);
  }
  return parsed;
}

const nodeEnv = optional('NODE_ENV', 'development') as NodeEnv;

const jwtSecret = required('JWT_SECRET');
if (nodeEnv === 'production' && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production.');
}

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isDevelopment: nodeEnv === 'development',

  port: intOf('PORT', 3000),
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:3000'),
  corsOrigin: optional('CORS_ORIGIN', 'http://localhost:4200'),

  // Origins allowed to frame the /embed help panel (space-separated for CSP
  // frame-ancestors). Default '*' = any site may embed the widget; restrict in
  // production by listing client domains, e.g. "https://app.acme.com".
  embedAllowedOrigins: optional('EMBED_ALLOWED_ORIGINS', '*'),

  databaseUrl: required('DATABASE_URL'),

  jwtSecret,
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '1h'),
  jwtRefreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '7d'),

  // Used to encrypt at-rest secrets (e.g. the stored Anthropic key).
  // Falls back to JWT_SECRET so the feature works without extra setup.
  settingsEncryptionKey: optional('SETTINGS_ENCRYPTION_KEY', jwtSecret),

  uploadDir: optional('UPLOAD_DIR', './uploads'),
  maxUploadMb: intOf('MAX_UPLOAD_MB', 10),

  // ── Voiceover Studio ──────────────────────────────────────────────────────
  // Every knob that affects cost, quality, or limits lives here so it can be
  // tuned per deployment without touching code.
  voiceover: {
    /** Walkthrough videos are far larger than help screenshots — own limit. */
    maxVideoUploadMb: intOf('MAX_VIDEO_UPLOAD_MB', 500),
    /** Default vision provider: anthropic | openai | gemini. */
    provider: optional('VOICEOVER_PROVIDER', 'anthropic'),
    /** Default model for script generation (must match the provider). */
    model: optional('VOICEOVER_MODEL', 'claude-opus-5'),
    /** Reasoning depth for script generation: low | medium | high | xhigh | max. */
    effort: optional('VOICEOVER_EFFORT', 'medium'),
    /** Output ceiling per script request. */
    maxTokens: intOf('VOICEOVER_MAX_TOKENS', 12_000),
    /** Hard cap on frames sent to the model — the main cost control. */
    maxFrames: intOf('VOICEOVER_MAX_FRAMES', 48),
    /** Frames per model request, bounding each call's image payload. */
    framesPerBatch: intOf('VOICEOVER_FRAMES_PER_BATCH', 12),
    /** Frame width in px. Enough to read UI text, far cheaper than full res. */
    frameWidth: intOf('VOICEOVER_FRAME_WIDTH', 960),
    /** JPEG quality for frames (ffmpeg -q:v scale, 1 best … 31 worst). */
    frameQuality: intOf('VOICEOVER_FRAME_QUALITY', 4),
    /** Scene-change sensitivity, 0–1. Lower catches more transitions. */
    sceneThreshold: floatOf('VOICEOVER_SCENE_THRESHOLD', 0.3),
    /** Never sample two frames closer together than this, in seconds. */
    minFrameGapSec: floatOf('VOICEOVER_MIN_FRAME_GAP_SEC', 1.5),
    /** Narration segment length bounds, in seconds. */
    minSegmentSec: floatOf('VOICEOVER_MIN_SEGMENT_SEC', 4),
    maxSegmentSec: floatOf('VOICEOVER_MAX_SEGMENT_SEC', 14),
    /** Speaking pace used to derive each segment's word budget. */
    wordsPerMinute: intOf('VOICEOVER_WORDS_PER_MINUTE', 150),
    /** How long a finished job stays available for review and export. */
    jobRetentionMinutes: intOf('VOICEOVER_JOB_RETENTION_MIN', 60),
  },

} as const;
