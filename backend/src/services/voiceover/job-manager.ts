/**
 * job-manager.ts — In-memory orchestrator for Voiceover Studio jobs.
 * ──────────────────────────────────────────────────────────────────
 * Owns the lifecycle of a probe → extract → script job:
 *   - holds job state + the provider API key IN MEMORY ONLY (scrubbed on finish)
 *   - persists each sampled frame as a real MediaAsset (permanent still URLs)
 *   - fans out progress events to all subscribed SSE clients
 *   - deletes the uploaded video once frames are extracted
 *   - supports cancellation and auto-expires finished jobs
 *
 * Mirrors the AI pipeline's job manager so both features behave identically
 * from the client's point of view.
 */

import type { Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { uploadDir } from '../../lib/upload.js';
import { logger } from '../../lib/logger.js';
import {
  detectSceneChanges,
  extractFrames,
  planFrameTimes,
  probeVideo,
} from './ffmpeg.service.js';
import { runScripter } from './script.service.js';
import {
  appendSegment,
  createScript,
  finaliseScript,
  loadFrames,
  saveFrames,
  saveMeta,
} from './script-store.service.js';
import { getSettings } from './settings.service.js';
import type { VoiceoverSettings } from './settings.service.js';
import { spokenSecondsFor } from './types.js';
import type {
  Frame,
  VideoMeta,
  VoEvent,
  VoJobConfig,
  VoJobPhase,
  VoLogEntry,
  VoSegment,
  VoTone,
} from './types.js';

interface VoJob {
  id: string;
  userId: string;
  phase: VoJobPhase;
  config: VoJobConfig;
  /** Scrubbed as soon as the run finishes. */
  apiKey: string | null;
  /** Uploaded video path — removed once frames are extracted. */
  videoPath: string | null;
  /**
   * Settings snapshot taken when the job started. Held for the whole run so an
   * edit made mid-job cannot change the frame plan or word budgets halfway
   * through and leave the script internally inconsistent.
   */
  settings: VoiceoverSettings;
  /** Row in `voiceover_scripts` this run writes to; null if storage failed. */
  scriptId: string | null;
  meta: VideoMeta | null;
  frames: Frame[];
  segments: VoSegment[];
  logs: VoLogEntry[];
  error: string | null;
  createdAt: string;
  abort: AbortController;
  subscribers: Set<Response>;
  expiryTimer: NodeJS.Timeout | null;
}

const JOBS = new Map<string, VoJob>();

// ── Public snapshot shapes ──────────────────────────────────────────────────

export interface PublicFrame {
  at: number;
  isSceneChange: boolean;
  imageUrl: string | null;
}

export interface VoJobSnapshot {
  id: string;
  phase: VoJobPhase;
  /** Durable record for this run — survives job expiry and restarts. */
  scriptId: string | null;
  config: VoJobConfig;
  /** What this run actually used, for traceability after settings change. */
  settings: VoiceoverSettings;
  meta: VideoMeta | null;
  frames: PublicFrame[];
  segments: VoSegment[];
  logs: VoLogEntry[];
  error: string | null;
  createdAt: string;
}

function toPublicFrame(f: Frame): PublicFrame {
  return { at: f.at, isSceneChange: f.isSceneChange, imageUrl: f.imageUrl };
}

export function snapshot(job: VoJob): VoJobSnapshot {
  return {
    id: job.id,
    phase: job.phase,
    scriptId: job.scriptId,
    config: job.config,
    settings: job.settings,
    meta: job.meta,
    frames: job.frames.map(toPublicFrame),
    segments: job.segments,
    logs: job.logs,
    error: job.error,
    createdAt: job.createdAt,
  };
}

export function getJob(id: string): VoJob | undefined {
  return JOBS.get(id);
}

// ── Event fan-out ────────────────────────────────────────────────────────────

function emit(job: VoJob, event: VoEvent): void {
  if (event.type === 'log') {
    job.logs.push({ level: event.level, message: event.message, at: new Date().toISOString() });
    if (job.logs.length > 500) job.logs.shift();
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.subscribers) {
    try {
      res.write(payload);
    } catch {
      job.subscribers.delete(res);
    }
  }
}

export function subscribe(job: VoJob, res: Response): void {
  job.subscribers.add(res);
  // Replay current state so a late subscriber catches up immediately.
  res.write(
    `data: ${JSON.stringify({ type: 'phase', phase: job.phase, message: 'connected' })}\n\n`,
  );
  if (job.meta) res.write(`data: ${JSON.stringify({ type: 'meta', meta: job.meta })}\n\n`);
  for (const s of job.segments) {
    res.write(`data: ${JSON.stringify({ type: 'segment', segment: s })}\n\n`);
  }
}

export function unsubscribe(job: VoJob, res: Response): void {
  job.subscribers.delete(res);
}

// ── Frame persistence ────────────────────────────────────────────────────────

async function saveFrame(
  userId: string,
  buffer: Buffer,
  at: number,
  videoName: string,
): Promise<{ imageUrl: string | null; mediaId: string | null; storagePath: string | null }> {
  try {
    const filename = `${randomUUID()}.jpg`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, buffer);
    const checksum = createHash('sha256').update(buffer).digest('hex');
    const publicUrl = `${env.publicBaseUrl}/uploads/${filename}`;

    const asset = await prisma.mediaAsset.create({
      data: {
        filename,
        originalName: `${videoName}-${at.toFixed(1)}s.jpg`
          .replace(/[^a-zA-Z0-9.\-_ ]/g, '')
          .slice(0, 120),
        mimeType: 'image/jpeg',
        sizeBytes: buffer.length,
        storagePath: filePath,
        publicUrl,
        checksum,
        altText: `Frame at ${at.toFixed(1)}s`,
        uploadedById: userId,
      },
    });
    return { imageUrl: asset.publicUrl, mediaId: asset.id, storagePath: filePath };
  } catch (err) {
    logger.warn('voiceover: frame save failed', { error: (err as Error).message });
    return { imageUrl: null, mediaId: null, storagePath: null };
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function setPhase(job: VoJob, phase: VoJobPhase, message: string): void {
  job.phase = phase;
  emit(job, { type: 'phase', phase, message });
}

function removeVideo(job: VoJob): void {
  if (!job.videoPath) return;
  try {
    if (fs.existsSync(job.videoPath)) fs.unlinkSync(job.videoPath);
  } catch (err) {
    logger.warn('voiceover: could not remove uploaded video', {
      error: (err as Error).message,
    });
  }
  job.videoPath = null;
}

function scheduleExpiry(job: VoJob): void {
  job.expiryTimer = setTimeout(() => {
    for (const res of job.subscribers) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    JOBS.delete(job.id);
  }, job.settings.jobRetentionMinutes * 60 * 1000);
}

function finish(job: VoJob): void {
  job.apiKey = null;
  removeVideo(job);
  for (const f of job.frames) delete f.base64;
  scheduleExpiry(job);
}

export interface StartVoJobInput {
  userId: string;
  videoPath: string;
  videoName: string;
  appName: string;
  audience: string;
  tone: VoTone;
  apiKey: string;
  model: string;
  provider: string;
  /** Effective settings, resolved by the caller so the route and job agree. */
  settings: VoiceoverSettings;
}

export function startJob(input: StartVoJobInput): string {
  const id = randomUUID();
  const job: VoJob = {
    id,
    userId: input.userId,
    phase: 'pending',
    config: {
      appName: input.appName,
      audience: input.audience,
      tone: input.tone,
      model: input.model,
      provider: input.provider,
      videoName: input.videoName,
    },
    apiKey: input.apiKey,
    videoPath: input.videoPath,
    settings: input.settings,
    scriptId: null,
    meta: null,
    frames: [],
    segments: [],
    logs: [],
    error: null,
    createdAt: new Date().toISOString(),
    abort: new AbortController(),
    subscribers: new Set(),
    expiryTimer: null,
  };
  JOBS.set(id, job);

  // Fire and forget — the run drives SSE events.
  void runJob(job);
  return id;
}

export function cancelJob(id: string): boolean {
  const job = JOBS.get(id);
  if (!job) return false;
  if (job.phase === 'done' || job.phase === 'error' || job.phase === 'cancelled') return false;
  job.abort.abort();
  return true;
}

async function runJob(job: VoJob): Promise<void> {
  const apiKey = job.apiKey;
  const videoPath = job.videoPath;
  if (!apiKey || !videoPath) return;

  // Opened before any work so a crash mid-run still leaves a record behind.
  job.scriptId = await createScript({
    videoName: job.config.videoName,
    appName: job.config.appName,
    audience: job.config.audience,
    tone: job.config.tone,
    provider: job.config.provider,
    model: job.config.model,
    wordsPerMinute: job.settings.wordsPerMinute,
    userId: job.userId,
  });

  try {
    // ── Phase 1: probe ───────────────────────────────────────────────────────
    setPhase(job, 'probing', 'Reading the video…');

    const meta = await probeVideo(videoPath, job.abort.signal);
    job.meta = meta;
    emit(job, { type: 'meta', meta });
    emit(job, {
      type: 'log',
      level: 'info',
      message: `${meta.durationSec.toFixed(1)}s, ${meta.width}x${meta.height} at ${meta.fps}fps`,
    });

    // ── Phase 2: extract ─────────────────────────────────────────────────────
    setPhase(job, 'extracting', 'Finding screen transitions…');

    const settings = job.settings;
    const sceneChanges = await detectSceneChanges(
      videoPath,
      settings.sceneThreshold,
      job.abort.signal,
    );
    emit(job, {
      type: 'log',
      level: 'info',
      message: `${sceneChanges.length} screen transitions detected`,
    });

    const maxFrames = settings.maxFrames;
    const planned = planFrameTimes(
      meta.durationSec,
      sceneChanges,
      maxFrames,
      settings.minFrameGapSec,
    );
    if (planned.length < sceneChanges.length + 1) {
      emit(job, {
        type: 'log',
        level: 'warn',
        message: `Sampling ${planned.length} frames (capped at ${maxFrames}); some transitions were skipped to control cost.`,
      });
    }

    setPhase(job, 'extracting', `Extracting ${planned.length} frames…`);
    const frames = await extractFrames(videoPath, planned, settings, job.abort.signal);
    job.frames = frames;

    // Persist the stills so the review table survives past the job's lifetime,
    // and so a different tone can be generated later without re-uploading.
    const storedFrames: Array<{
      at: number;
      isSceneChange: boolean;
      imageUrl: string | null;
      storagePath: string;
    }> = [];
    for (const frame of frames) {
      if (!frame.base64) continue;
      const saved = await saveFrame(
        job.userId,
        Buffer.from(frame.base64, 'base64'),
        frame.at,
        job.config.videoName,
      );
      frame.imageUrl = saved.imageUrl;
      if (saved.storagePath) {
        storedFrames.push({
          at: frame.at,
          isSceneChange: frame.isSceneChange,
          imageUrl: saved.imageUrl,
          storagePath: saved.storagePath,
        });
      }
    }
    if (job.scriptId) await saveFrames(job.scriptId, storedFrames);

    emit(job, {
      type: 'frames',
      count: frames.length,
      sceneChanges: frames.filter((f) => f.isSceneChange).length,
    });

    if (job.scriptId) await saveMeta(job.scriptId, meta, frames.length);

    // The video itself is no longer needed — the frames carry everything.
    removeVideo(job);

    // ── Phase 3: script ──────────────────────────────────────────────────────
    setPhase(job, 'scripting', 'Writing the voiceover script…');

    const segments = await runScripter({
      appName: job.config.appName,
      audience: job.config.audience,
      tone: job.config.tone,
      apiKey,
      model: job.config.model,
      settings,
      frames: job.frames,
      durationSec: meta.durationSec,
      signal: job.abort.signal,
      onSegment: (segment) => {
        job.segments.push(segment);
        emit(job, { type: 'segment', segment });
        // Persisted per segment rather than in bulk at the end, so a failure
        // partway through still keeps everything generated so far.
        if (job.scriptId) void appendSegment(job.scriptId, segment);
      },
      onLog: (level, message) => emit(job, { type: 'log', level, message }),
    });

    const totalWords = segments.reduce((sum, s) => sum + s.wordCount, 0);
    const spokenSec = spokenSecondsFor(totalWords, settings.wordsPerMinute);

    if (job.scriptId) await finaliseScript(job.scriptId, 'done', totalWords);

    setPhase(job, 'done', 'Script complete');
    emit(job, {
      type: 'done',
      scriptId: job.scriptId,
      totalSegments: segments.length,
      totalWords,
      spokenSec: Number(spokenSec.toFixed(1)),
    });
  } catch (err) {
    const message = (err as Error).message || 'Voiceover job failed';
    const words = job.segments.reduce((sum, s) => sum + s.wordCount, 0);
    if (job.abort.signal.aborted) {
      job.phase = 'cancelled';
      job.error = 'Cancelled';
      if (job.scriptId) await finaliseScript(job.scriptId, 'cancelled', words, 'Cancelled');
      emit(job, { type: 'phase', phase: 'cancelled', message: 'Job cancelled' });
    } else {
      job.phase = 'error';
      job.error = message;
      if (job.scriptId) await finaliseScript(job.scriptId, 'error', words, message);
      emit(job, { type: 'error', message });
    }
  } finally {
    finish(job);
    // Give SSE clients a moment to receive the final event, then close streams.
    setTimeout(() => {
      for (const res of job.subscribers) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
    }, 1000);
  }
}

// ── Regeneration ─────────────────────────────────────────────────────────────

export interface RegenerateInput {
  userId: string;
  /** The script whose frames are reused. */
  sourceScriptId: string;
  tone: VoTone;
  /** Optional overrides; default to the source script's values. */
  appName?: string;
  audience?: string;
  apiKey: string;
  model: string;
  provider: string;
  settings: VoiceoverSettings;
  /** Facts copied from the source so the new record reads the same. */
  source: {
    videoName: string;
    appName: string;
    audience: string;
    durationSec: number;
    width: number;
    height: number;
    fps: number;
  };
}

/**
 * Re-run the scripter over an existing script's stored stills with a different
 * tone. Skips probing and extraction entirely — the video is long gone by now,
 * which is exactly why the frames are kept on disk.
 */
export function startRegenerateJob(input: RegenerateInput): string {
  const id = randomUUID();
  const job: VoJob = {
    id,
    userId: input.userId,
    phase: 'pending',
    config: {
      appName: input.appName?.trim() || input.source.appName,
      audience: input.audience?.trim() || input.source.audience,
      tone: input.tone,
      model: input.model,
      provider: input.provider,
      videoName: input.source.videoName,
    },
    apiKey: input.apiKey,
    // Nothing was uploaded for a regeneration.
    videoPath: null,
    settings: input.settings,
    scriptId: null,
    meta: {
      durationSec: input.source.durationSec,
      width: input.source.width,
      height: input.source.height,
      fps: input.source.fps,
      sizeBytes: 0,
    },
    frames: [],
    segments: [],
    logs: [],
    error: null,
    createdAt: new Date().toISOString(),
    abort: new AbortController(),
    subscribers: new Set(),
    expiryTimer: null,
  };
  JOBS.set(id, job);

  void runRegenerate(job, input.sourceScriptId);
  return id;
}

async function runRegenerate(job: VoJob, sourceScriptId: string): Promise<void> {
  const apiKey = job.apiKey;
  if (!apiKey) return;

  job.scriptId = await createScript({
    videoName: job.config.videoName,
    appName: job.config.appName,
    audience: job.config.audience,
    tone: job.config.tone,
    provider: job.config.provider,
    model: job.config.model,
    wordsPerMinute: job.settings.wordsPerMinute,
    userId: job.userId,
    sourceScriptId,
  });

  try {
    setPhase(job, 'extracting', 'Loading stored frames…');

    const stored = await loadFrames(sourceScriptId);
    if (stored.length === 0) {
      throw new Error(
        'The stills for that script are no longer on disk, so it cannot be re-toned. Upload the video again.',
      );
    }

    // Re-read the bytes rather than the public URL: the file is local, and this
    // avoids a round trip through the web server for every frame.
    job.frames = stored.map((f) => ({
      at: f.at,
      isSceneChange: f.isSceneChange,
      imageUrl: f.imageUrl,
      base64: fs.readFileSync(f.storagePath).toString('base64'),
    }));

    if (job.meta && job.scriptId) await saveMeta(job.scriptId, job.meta, job.frames.length);

    emit(job, {
      type: 'frames',
      count: job.frames.length,
      sceneChanges: job.frames.filter((f) => f.isSceneChange).length,
    });
    emit(job, {
      type: 'log',
      level: 'info',
      message: `Reusing ${job.frames.length} stored frames — no re-upload needed.`,
    });

    setPhase(job, 'scripting', `Rewriting narration in a ${job.config.tone} tone…`);

    const segments = await runScripter({
      appName: job.config.appName,
      audience: job.config.audience,
      tone: job.config.tone as VoTone,
      apiKey,
      model: job.config.model,
      settings: job.settings,
      frames: job.frames,
      durationSec: job.meta?.durationSec ?? 0,
      signal: job.abort.signal,
      onSegment: (segment) => {
        job.segments.push(segment);
        emit(job, { type: 'segment', segment });
        if (job.scriptId) void appendSegment(job.scriptId, segment);
      },
      onLog: (level, message) => emit(job, { type: 'log', level, message }),
    });

    const totalWords = segments.reduce((sum, s) => sum + s.wordCount, 0);
    if (job.scriptId) await finaliseScript(job.scriptId, 'done', totalWords);

    setPhase(job, 'done', 'Script complete');
    emit(job, {
      type: 'done',
      scriptId: job.scriptId,
      totalSegments: segments.length,
      totalWords,
      spokenSec: Number(spokenSecondsFor(totalWords, job.settings.wordsPerMinute).toFixed(1)),
    });
  } catch (err) {
    const message = (err as Error).message || 'Regeneration failed';
    const words = job.segments.reduce((sum, s) => sum + s.wordCount, 0);
    if (job.abort.signal.aborted) {
      job.phase = 'cancelled';
      job.error = 'Cancelled';
      if (job.scriptId) await finaliseScript(job.scriptId, 'cancelled', words, 'Cancelled');
      emit(job, { type: 'phase', phase: 'cancelled', message: 'Job cancelled' });
    } else {
      job.phase = 'error';
      job.error = message;
      if (job.scriptId) await finaliseScript(job.scriptId, 'error', words, message);
      emit(job, { type: 'error', message });
    }
  } finally {
    finish(job);
    setTimeout(() => {
      for (const res of job.subscribers) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
    }, 1000);
  }
}
