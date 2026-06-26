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
} as const;
