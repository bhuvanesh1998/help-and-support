/**
 * job-manager.ts — In-memory orchestrator for AI pipeline jobs.
 * ────────────────────────────────────────────────────────────────
 * Owns the lifecycle of a scrape → draft job:
 *   - holds job state + secrets IN MEMORY ONLY (scrubbed on completion)
 *   - persists each screenshot as a real MediaAsset (permanent image URLs)
 *   - fans out progress events to all subscribed SSE clients
 *   - supports cancellation and auto-expires finished jobs
 *
 * Secrets (Anthropic key, target password) are never written to disk or DB.
 */

import type { Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { uploadDir } from '../../lib/upload.js';
import { logger } from '../../lib/logger.js';
import { runScraper } from './scraper.service.js';
import { runDrafter } from './ai-draft.service.js';
import type {
  CapturedScreen,
  DraftTutorial,
  JobConfig,
  JobPhase,
  JobSecrets,
  LogEntry,
  PipelineEvent,
  PublicScreen,
  ScreenGroup,
  SessionInjection,
} from './types.js';

interface Job {
  id: string;
  userId: string;
  phase: JobPhase;
  config: JobConfig;
  secrets: JobSecrets | null;
  screens: CapturedScreen[];
  groups: ScreenGroup[];
  tutorials: DraftTutorial[];
  logs: LogEntry[];
  error: string | null;
  createdAt: string;
  abort: AbortController;
  subscribers: Set<Response>;
  expiryTimer: NodeJS.Timeout | null;
}

const JOBS = new Map<string, Job>();
const EXPIRY_MS = 30 * 60 * 1000; // keep finished jobs for 30 min for review

// ── Public snapshot shapes ──────────────────────────────────────────────────

export interface JobSnapshot {
  id: string;
  phase: JobPhase;
  config: JobConfig;
  screens: PublicScreen[];
  groups: ScreenGroup[];
  tutorials: DraftTutorial[];
  logs: LogEntry[];
  error: string | null;
  createdAt: string;
}

function toPublicScreen(s: CapturedScreen): PublicScreen {
  return {
    id: s.id,
    name: s.name,
    group: s.group,
    url: s.url,
    imageUrl: s.imageUrl,
    mediaId: s.mediaId,
    apiCalls: s.apiCalls,
    capturedAt: s.capturedAt,
    dom: { heading: s.dom.heading, title: s.dom.title },
  };
}

export function snapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    phase: job.phase,
    config: job.config,
    screens: job.screens.map(toPublicScreen),
    groups: job.groups,
    tutorials: job.tutorials,
    logs: job.logs,
    error: job.error,
    createdAt: job.createdAt,
  };
}

export function getJob(id: string): Job | undefined {
  return JOBS.get(id);
}

// ── Event fan-out ────────────────────────────────────────────────────────────

function emit(job: Job, event: PipelineEvent): void {
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

export function subscribe(job: Job, res: Response): void {
  job.subscribers.add(res);
  // Replay the current state so a late subscriber catches up immediately.
  res.write(`data: ${JSON.stringify({ type: 'phase', phase: job.phase, message: 'connected' })}\n\n`);
  for (const s of job.screens) {
    res.write(`data: ${JSON.stringify({ type: 'screen', screen: toPublicScreen(s) })}\n\n`);
  }
  for (const t of job.tutorials) {
    res.write(`data: ${JSON.stringify({ type: 'draft', tutorial: t })}\n\n`);
  }
}

export function unsubscribe(job: Job, res: Response): void {
  job.subscribers.delete(res);
}

// ── Screenshot persistence ─────────────────────────────────────────────────────

async function saveScreenshot(
  userId: string,
  buffer: Buffer,
  screenId: string,
  name: string,
): Promise<{ imageUrl: string | null; mediaId: string | null }> {
  try {
    const filename = `${randomUUID()}.png`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, buffer);
    const checksum = createHash('sha256').update(buffer).digest('hex');
    const publicUrl = `${env.publicBaseUrl}/uploads/${filename}`;

    const asset = await prisma.mediaAsset.create({
      data: {
        filename,
        originalName: `${screenId}-${name}.png`.replace(/[^a-zA-Z0-9.\-_ ]/g, '').slice(0, 120),
        mimeType: 'image/png',
        sizeBytes: buffer.length,
        storagePath: filePath,
        publicUrl,
        checksum,
        altText: name,
        uploadedById: userId,
      },
    });
    return { imageUrl: asset.publicUrl, mediaId: asset.id };
  } catch (err) {
    logger.warn('ai-pipeline: screenshot save failed', { error: (err as Error).message });
    return { imageUrl: null, mediaId: null };
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function setPhase(job: Job, phase: JobPhase, message: string): void {
  job.phase = phase;
  emit(job, { type: 'phase', phase, message });
}

function scheduleExpiry(job: Job): void {
  job.expiryTimer = setTimeout(() => {
    for (const res of job.subscribers) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    JOBS.delete(job.id);
  }, EXPIRY_MS);
}

function finish(job: Job): void {
  // Scrub secrets and large in-memory blobs.
  job.secrets = null;
  for (const s of job.screens) delete s.base64;
  scheduleExpiry(job);
}

export interface StartJobInput {
  userId: string;
  baseUrl: string;
  appName: string;
  email: string;
  password: string;
  anthropicKey: string;
  model: string;
  navDepth: number;
  headed: boolean;
  session?: SessionInjection;
}

export function startJob(input: StartJobInput): string {
  const id = randomUUID();
  const job: Job = {
    id,
    userId: input.userId,
    phase: 'pending',
    config: {
      baseUrl: input.baseUrl,
      appName: input.appName,
      email: input.email,
      navDepth: input.navDepth,
      model: input.model,
      headed: input.headed,
    },
    secrets: { password: input.password, anthropicKey: input.anthropicKey, session: input.session },
    screens: [],
    groups: [],
    tutorials: [],
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

async function runJob(job: Job): Promise<void> {
  const secrets = job.secrets;
  if (!secrets) return;

  try {
    // ── Phase 1: scrape ──────────────────────────────────────────────────────
    setPhase(job, 'scraping', 'Mapping screens…');

    const { screens, groups } = await runScraper({
      baseUrl: job.config.baseUrl,
      appName: job.config.appName,
      email: job.config.email,
      password: secrets.password,
      navDepth: job.config.navDepth,
      headed: job.config.headed,
      manualTimeoutMs: 180_000,
      session: secrets.session,
      signal: job.abort.signal,
      saveScreenshot: (buffer, screenId, name) =>
        saveScreenshot(job.userId, buffer, screenId, name),
      onScreen: (screen) => {
        job.screens.push(screen);
        emit(job, { type: 'screen', screen: toPublicScreen(screen) });
      },
      onLog: (level, message) => emit(job, { type: 'log', level, message }),
    });

    job.groups = groups;
    for (const g of groups) emit(job, { type: 'group', group: g });

    if (screens.length === 0) {
      throw new Error('No screens could be captured. Check the app URL and that /login is reachable.');
    }

    // ── Phase 2: draft ───────────────────────────────────────────────────────
    setPhase(job, 'drafting', 'Writing tutorials with AI…');

    const tutorials = await runDrafter({
      appName: job.config.appName,
      anthropicKey: secrets.anthropicKey,
      model: job.config.model,
      screens: job.screens,
      groups: job.groups,
      signal: job.abort.signal,
      onTutorial: (tutorial) => {
        job.tutorials.push(tutorial);
        emit(job, { type: 'draft', tutorial });
      },
      onLog: (level, message) => emit(job, { type: 'log', level, message }),
    });

    setPhase(job, 'done', 'Pipeline complete');
    emit(job, {
      type: 'done',
      totalScreens: job.screens.length,
      totalTutorials: tutorials.length,
    });
  } catch (err) {
    const message = (err as Error).message || 'Pipeline failed';
    if (job.abort.signal.aborted) {
      job.phase = 'cancelled';
      job.error = 'Cancelled';
      emit(job, { type: 'phase', phase: 'cancelled', message: 'Job cancelled' });
    } else {
      job.phase = 'error';
      job.error = message;
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
