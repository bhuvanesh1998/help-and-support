/**
 * settings.service.ts — Runtime-editable Voiceover Studio settings.
 * ─────────────────────────────────────────────────────────────────
 * Every knob that affects cost, quality, or limits is editable from the admin
 * UI and persisted, so tuning no longer needs a redeploy.
 *
 * Precedence: saved row → environment variable → built-in default. A fresh
 * install with no row behaves exactly as the env-only version did, which keeps
 * existing deployments working untouched.
 *
 * Values are clamped on save: these feed ffmpeg arguments and model request
 * bodies, so an out-of-range number is a broken job, not a preference.
 */

import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { PROVIDER_META, isProviderId, type ProviderId } from './providers/index.js';

const NAME = 'default';

/** Effort levels accepted by the Messages API. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * Model IDs are free-form rather than an allowlist: providers ship new models
 * faster than this code would be redeployed, and a stale allowlist silently
 * blocks the model the operator actually wants. The format is still validated.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface VoiceoverSettings {
  maxVideoUploadMb: number;
  /** Which vision provider reads the frames. */
  provider: ProviderId;
  model: string;
  effort: Effort;
  maxTokens: number;
  maxFrames: number;
  framesPerBatch: number;
  frameWidth: number;
  frameQuality: number;
  sceneThreshold: number;
  minFrameGapSec: number;
  minSegmentSec: number;
  maxSegmentSec: number;
  wordsPerMinute: number;
  jobRetentionMinutes: number;
}

/** Allowed range for every numeric field, enforced on save. */
export const BOUNDS = {
  maxVideoUploadMb: { min: 1, max: 4096 },
  maxTokens: { min: 1024, max: 128_000 },
  maxFrames: { min: 4, max: 200 },
  framesPerBatch: { min: 1, max: 32 },
  frameWidth: { min: 320, max: 2576 },
  frameQuality: { min: 1, max: 31 },
  sceneThreshold: { min: 0.05, max: 1 },
  minFrameGapSec: { min: 0.2, max: 30 },
  minSegmentSec: { min: 1, max: 60 },
  maxSegmentSec: { min: 2, max: 120 },
  wordsPerMinute: { min: 60, max: 260 },
  jobRetentionMinutes: { min: 5, max: 1440 },
} as const;

/** The environment-derived baseline, used whenever no row is saved. */
export function envDefaults(): VoiceoverSettings {
  const effort = env.voiceover.effort as Effort;
  const provider: ProviderId = isProviderId(env.voiceover.provider)
    ? env.voiceover.provider
    : 'anthropic';
  return {
    maxVideoUploadMb: env.voiceover.maxVideoUploadMb,
    provider,
    model: env.voiceover.model,
    effort: EFFORT_LEVELS.includes(effort) ? effort : 'medium',
    maxTokens: env.voiceover.maxTokens,
    maxFrames: env.voiceover.maxFrames,
    framesPerBatch: env.voiceover.framesPerBatch,
    frameWidth: env.voiceover.frameWidth,
    frameQuality: env.voiceover.frameQuality,
    sceneThreshold: env.voiceover.sceneThreshold,
    minFrameGapSec: env.voiceover.minFrameGapSec,
    minSegmentSec: env.voiceover.minSegmentSec,
    maxSegmentSec: env.voiceover.maxSegmentSec,
    wordsPerMinute: env.voiceover.wordsPerMinute,
    jobRetentionMinutes: env.voiceover.jobRetentionMinutes,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function intField(
  raw: unknown,
  fallback: number,
  bound: { min: number; max: number },
): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(clamp(parsed, bound.min, bound.max));
}

function floatField(
  raw: unknown,
  fallback: number,
  bound: { min: number; max: number },
): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Number(clamp(parsed, bound.min, bound.max).toFixed(2));
}

/**
 * Coerce an untrusted patch into a complete, in-range settings object.
 * Unknown or unparseable fields keep their current value rather than resetting.
 */
export function sanitize(
  patch: Record<string, unknown>,
  current: VoiceoverSettings,
): VoiceoverSettings {
  const modelRaw = typeof patch['model'] === 'string' ? patch['model'].trim() : '';
  const effortRaw = typeof patch['effort'] === 'string' ? patch['effort'] : '';
  const providerRaw = patch['provider'];
  const provider: ProviderId = isProviderId(providerRaw) ? providerRaw : current.provider;

  // Switching provider without naming a model would otherwise carry the old
  // provider's model across, which that provider will reject.
  const providerChanged = provider !== current.provider;
  const model = MODEL_PATTERN.test(modelRaw)
    ? modelRaw
    : providerChanged
      ? PROVIDER_META[provider].defaultModel
      : current.model;

  const settings: VoiceoverSettings = {
    maxVideoUploadMb: intField(
      patch['maxVideoUploadMb'],
      current.maxVideoUploadMb,
      BOUNDS.maxVideoUploadMb,
    ),
    provider,
    model,
    effort: (EFFORT_LEVELS as readonly string[]).includes(effortRaw)
      ? (effortRaw as Effort)
      : current.effort,
    maxTokens: intField(patch['maxTokens'], current.maxTokens, BOUNDS.maxTokens),
    maxFrames: intField(patch['maxFrames'], current.maxFrames, BOUNDS.maxFrames),
    framesPerBatch: intField(
      patch['framesPerBatch'],
      current.framesPerBatch,
      BOUNDS.framesPerBatch,
    ),
    frameWidth: intField(patch['frameWidth'], current.frameWidth, BOUNDS.frameWidth),
    frameQuality: intField(patch['frameQuality'], current.frameQuality, BOUNDS.frameQuality),
    sceneThreshold: floatField(
      patch['sceneThreshold'],
      current.sceneThreshold,
      BOUNDS.sceneThreshold,
    ),
    minFrameGapSec: floatField(
      patch['minFrameGapSec'],
      current.minFrameGapSec,
      BOUNDS.minFrameGapSec,
    ),
    minSegmentSec: floatField(patch['minSegmentSec'], current.minSegmentSec, BOUNDS.minSegmentSec),
    maxSegmentSec: floatField(patch['maxSegmentSec'], current.maxSegmentSec, BOUNDS.maxSegmentSec),
    wordsPerMinute: intField(
      patch['wordsPerMinute'],
      current.wordsPerMinute,
      BOUNDS.wordsPerMinute,
    ),
    jobRetentionMinutes: intField(
      patch['jobRetentionMinutes'],
      current.jobRetentionMinutes,
      BOUNDS.jobRetentionMinutes,
    ),
  };

  // A segment can never be shorter than its own minimum.
  if (settings.maxSegmentSec < settings.minSegmentSec) {
    settings.maxSegmentSec = settings.minSegmentSec;
  }
  // Batching more frames than are ever sampled would leave empty batches.
  if (settings.framesPerBatch > settings.maxFrames) {
    settings.framesPerBatch = settings.maxFrames;
  }
  return settings;
}

/** Effective settings: the saved row if present, otherwise the env baseline. */
export async function getSettings(): Promise<VoiceoverSettings> {
  const defaults = envDefaults();
  try {
    const row = await prisma.voiceoverSetting.findUnique({ where: { name: NAME } });
    if (!row) return defaults;
    return {
      maxVideoUploadMb: row.maxVideoUploadMb,
      provider: isProviderId(row.provider) ? row.provider : defaults.provider,
      model: row.model,
      effort: (EFFORT_LEVELS as readonly string[]).includes(row.effort)
        ? (row.effort as Effort)
        : defaults.effort,
      maxTokens: row.maxTokens,
      maxFrames: row.maxFrames,
      framesPerBatch: row.framesPerBatch,
      frameWidth: row.frameWidth,
      frameQuality: row.frameQuality,
      sceneThreshold: row.sceneThreshold,
      minFrameGapSec: row.minFrameGapSec,
      minSegmentSec: row.minSegmentSec,
      maxSegmentSec: row.maxSegmentSec,
      wordsPerMinute: row.wordsPerMinute,
      jobRetentionMinutes: row.jobRetentionMinutes,
    };
  } catch {
    // Table missing (migration not yet applied) — fall back rather than 500.
    return defaults;
  }
}

/** Validate and persist a patch, returning the effective settings. */
export async function saveSettings(
  patch: Record<string, unknown>,
  userId: string,
): Promise<VoiceoverSettings> {
  const clean = sanitize(patch, await getSettings());
  await prisma.voiceoverSetting.upsert({
    where: { name: NAME },
    update: { ...clean, updatedById: userId },
    create: { name: NAME, ...clean, updatedById: userId },
  });
  return clean;
}

/** Drop the saved row so the environment baseline applies again. */
export async function resetSettings(): Promise<VoiceoverSettings> {
  await prisma.voiceoverSetting.deleteMany({ where: { name: NAME } });
  return envDefaults();
}
