/**
 * script-store.service.ts — Durable storage for generated scripts.
 * ────────────────────────────────────────────────────────────────
 * The job manager is in-memory: navigating away, job expiry or a restart all
 * lose the output. Every run therefore writes a `voiceover_scripts` row as soon
 * as it starts and appends each segment as it arrives, so a script survives all
 * three — and a run that fails or is cancelled still keeps what it produced.
 *
 * Writes are best-effort: a storage failure logs and lets the run continue
 * rather than destroying a script the model already paid for.
 */

import fs from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import type { VideoMeta, VoSegment } from './types.js';

/** Row shape for the saved-scripts list (no segments). */
export interface ScriptSummary {
  id: string;
  videoName: string;
  appName: string;
  tone: string;
  provider: string;
  model: string;
  status: string;
  durationSec: number;
  segmentCount: number;
  totalWords: number;
  /** Set when this is another tone of an earlier run's frames. */
  sourceScriptId: string | null;
  /** How many other tones exist for the same frames. */
  variantCount: number;
  /** True when the stills are still on disk, so a re-tone is possible. */
  canRegenerate: boolean;
  createdAt: string;
}

/** Filters for the library listing. */
export interface ScriptQuery {
  /** Free text over video name and app name. */
  search?: string;
  status?: string;
  tone?: string;
  provider?: string;
  limit?: number;
}

export interface ScriptDetail extends ScriptSummary {
  audience: string;
  tone: string;
  width: number;
  height: number;
  fps: number;
  wordsPerMinute: number;
  frameCount: number;
  error: string | null;
  segments: VoSegment[];
}

export interface CreateScriptInput {
  videoName: string;
  appName: string;
  audience: string;
  tone: string;
  provider: string;
  model: string;
  wordsPerMinute: number;
  userId: string;
  /** Present when re-running an earlier script's frames in another tone. */
  sourceScriptId?: string | null;
}

/** A stored still, with the on-disk path needed to re-send it to a model. */
export interface StoredFrame {
  at: number;
  isSceneChange: boolean;
  imageUrl: string | null;
  storagePath: string;
}

/** Open a record for a run that just started. Returns null if storage failed. */
export async function createScript(input: CreateScriptInput): Promise<string | null> {
  try {
    const row = await prisma.voiceoverScript.create({
      data: {
        videoName: input.videoName,
        appName: input.appName,
        audience: input.audience,
        tone: input.tone,
        provider: input.provider,
        model: input.model,
        wordsPerMinute: input.wordsPerMinute,
        status: 'running',
        sourceScriptId: input.sourceScriptId ?? null,
        createdById: input.userId,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    logger.warn('voiceover: could not create script record', {
      error: (err as Error).message,
    });
    return null;
  }
}

/** Record the source video's facts once probing finishes. */
export async function saveMeta(
  scriptId: string,
  meta: VideoMeta,
  frameCount: number,
): Promise<void> {
  try {
    await prisma.voiceoverScript.update({
      where: { id: scriptId },
      data: {
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        // Videos can exceed a 32-bit int; store the cap rather than fail the write.
        sizeBytes: Math.min(meta.sizeBytes, 2_147_483_647),
        frameCount,
      },
    });
  } catch (err) {
    logger.warn('voiceover: could not save video meta', { error: (err as Error).message });
  }
}

/**
 * Store the sampled stills. Their on-disk paths are what make a re-tone
 * possible: the uploaded video is deleted once extraction finishes.
 */
export async function saveFrames(
  scriptId: string,
  frames: Array<{ at: number; isSceneChange: boolean; imageUrl: string | null; storagePath: string }>,
): Promise<void> {
  if (frames.length === 0) return;
  try {
    await prisma.voiceoverFrame.createMany({
      data: frames.map((f) => ({
        scriptId,
        at: f.at,
        isSceneChange: f.isSceneChange,
        imageUrl: f.imageUrl,
        storagePath: f.storagePath,
      })),
    });
  } catch (err) {
    logger.warn('voiceover: could not save frames', { error: (err as Error).message });
  }
}

/**
 * The stills for a script, in order — reading from the source run when this is
 * already a variant, so tone variants always trace back to one frame set.
 * Frames whose file has since been deleted are skipped.
 */
export async function loadFrames(scriptId: string): Promise<StoredFrame[]> {
  const row = await prisma.voiceoverScript.findUnique({
    where: { id: scriptId },
    select: { sourceScriptId: true },
  });
  const ownerId = row?.sourceScriptId ?? scriptId;

  const frames = await prisma.voiceoverFrame.findMany({
    where: { scriptId: ownerId },
    orderBy: { at: 'asc' },
  });

  return frames
    .filter((f) => fs.existsSync(f.storagePath))
    .map((f) => ({
      at: f.at,
      isSceneChange: f.isSceneChange,
      imageUrl: f.imageUrl,
      storagePath: f.storagePath,
    }));
}

/** Append one segment as the model produces it. */
export async function appendSegment(scriptId: string, segment: VoSegment): Promise<void> {
  try {
    await prisma.voiceoverSegment.create({
      data: {
        scriptId,
        index: segment.index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        onScreen: segment.onScreen,
        script: segment.script,
        wordBudget: segment.wordBudget,
        wordCount: segment.wordCount,
        imageUrl: segment.imageUrl,
      },
    });
  } catch (err) {
    logger.warn('voiceover: could not save segment', {
      index: segment.index,
      error: (err as Error).message,
    });
  }
}

/** Close the record out. A partial script is kept, flagged by its status. */
export async function finaliseScript(
  scriptId: string,
  status: 'done' | 'error' | 'cancelled',
  totalWords: number,
  error?: string | null,
): Promise<void> {
  try {
    await prisma.voiceoverScript.update({
      where: { id: scriptId },
      data: { status, totalWords, error: error ?? null },
    });
  } catch (err) {
    logger.warn('voiceover: could not finalise script record', {
      error: (err as Error).message,
    });
  }
}

/** Most recent scripts first, optionally searched and filtered. */
export async function listScripts(query: ScriptQuery = {}): Promise<ScriptSummary[]> {
  const where: Prisma.VoiceoverScriptWhereInput = {};
  const search = query.search?.trim();
  if (search) {
    where.OR = [
      { videoName: { contains: search, mode: 'insensitive' } },
      { appName: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (query.status) where.status = query.status;
  if (query.tone) where.tone = query.tone;
  if (query.provider) where.provider = query.provider;

  const rows = await prisma.voiceoverScript.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(query.limit ?? 100, 1), 300),
    include: {
      _count: { select: { segments: true, variants: true, frames: true } },
    },
  });

  // A variant's frames live on its source, so its own frame count is zero —
  // resolve those in one extra query rather than per row.
  const sourceIds = [...new Set(rows.map((r) => r.sourceScriptId).filter((id): id is string => !!id))];
  const sourceFrameCounts = new Map<string, number>();
  if (sourceIds.length) {
    const grouped = await prisma.voiceoverFrame.groupBy({
      by: ['scriptId'],
      where: { scriptId: { in: sourceIds } },
      _count: { _all: true },
    });
    for (const g of grouped) sourceFrameCounts.set(g.scriptId, g._count._all);
  }

  return rows.map((r) => {
    const frameCount = r.sourceScriptId
      ? (sourceFrameCounts.get(r.sourceScriptId) ?? 0)
      : r._count.frames;
    return {
      id: r.id,
      videoName: r.videoName,
      appName: r.appName,
      tone: r.tone,
      provider: r.provider,
      model: r.model,
      status: r.status,
      durationSec: r.durationSec,
      segmentCount: r._count.segments,
      totalWords: r.totalWords,
      sourceScriptId: r.sourceScriptId,
      variantCount: r._count.variants,
      canRegenerate: frameCount > 0,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Distinct values present in storage, so filters only offer real options. */
export async function listFilterOptions(): Promise<{
  tones: string[];
  providers: string[];
  statuses: string[];
}> {
  const [tones, providers, statuses] = await Promise.all([
    prisma.voiceoverScript.findMany({ distinct: ['tone'], select: { tone: true } }),
    prisma.voiceoverScript.findMany({ distinct: ['provider'], select: { provider: true } }),
    prisma.voiceoverScript.findMany({ distinct: ['status'], select: { status: true } }),
  ]);
  return {
    tones: tones.map((t) => t.tone).sort(),
    providers: providers.map((p) => p.provider).sort(),
    statuses: statuses.map((s) => s.status).sort(),
  };
}

/** One script with its segments in order, or null when it does not exist. */
export async function getScript(id: string): Promise<ScriptDetail | null> {
  const row = await prisma.voiceoverScript.findUnique({
    where: { id },
    include: {
      segments: { orderBy: { index: 'asc' } },
      _count: { select: { variants: true } },
    },
  });
  if (!row) return null;

  const frames = await loadFrames(id);

  return {
    id: row.id,
    videoName: row.videoName,
    appName: row.appName,
    audience: row.audience,
    tone: row.tone,
    sourceScriptId: row.sourceScriptId,
    variantCount: row._count.variants,
    canRegenerate: frames.length > 0,
    provider: row.provider,
    model: row.model,
    status: row.status,
    durationSec: row.durationSec,
    width: row.width,
    height: row.height,
    fps: row.fps,
    wordsPerMinute: row.wordsPerMinute,
    frameCount: row.frameCount,
    totalWords: row.totalWords,
    error: row.error,
    segmentCount: row.segments.length,
    createdAt: row.createdAt.toISOString(),
    segments: row.segments.map((s) => ({
      index: s.index,
      startSec: s.startSec,
      endSec: s.endSec,
      onScreen: s.onScreen,
      script: s.script,
      wordBudget: s.wordBudget,
      wordCount: s.wordCount,
      imageUrl: s.imageUrl,
      editedAt: s.editedAt?.toISOString() ?? null,
    })),
  };
}

/** Segments cascade with the parent row. */
export async function deleteScript(id: string): Promise<boolean> {
  try {
    // Rows cascade, but the rendered MP3s are ours alone and would otherwise sit
    // in the uploads directory forever. Read the paths before the cascade drops
    // the rows that point at them.
    const clips = await prisma.voiceoverAudio.findMany({
      where: { scriptId: id },
      select: { storagePath: true },
    });

    await prisma.voiceoverScript.delete({ where: { id } });

    for (const clip of clips) {
      try {
        if (fs.existsSync(clip.storagePath)) fs.unlinkSync(clip.storagePath);
      } catch {
        /* best effort — the row is already gone, a stray file is harmless */
      }
    }

    // Frame stills are deliberately left: they are MediaAssets the media library
    // owns, and may be referenced by manual pages.
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark scripts left mid-run as interrupted.
 *
 * A job lives in memory, so a restart abandons it while its row still says
 * "running" — with no process left to ever finish it. Called once at boot so the
 * library never shows a run that cannot progress. Anything genuinely in flight
 * belongs to this process and was created after it started, so a conservative
 * age cutoff leaves live jobs alone.
 */
export async function reconcileInterruptedScripts(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - 60_000);
    const result = await prisma.voiceoverScript.updateMany({
      where: { status: 'running', createdAt: { lt: cutoff } },
      data: {
        status: 'error',
        error: 'Interrupted — the server restarted while this script was being generated.',
      },
    });
    if (result.count > 0) {
      logger.info('voiceover: marked interrupted scripts', { count: result.count });
    }
    return result.count;
  } catch (err) {
    logger.warn('voiceover: could not reconcile interrupted scripts', {
      error: (err as Error).message,
    });
    return 0;
  }
}

/**
 * Replace one segment's narration with a human edit.
 *
 * The word count is recomputed here rather than trusted from the client, since
 * it is what the over-budget warning is based on. `editedAt` marks the line as
 * hand-written so a later regeneration does not quietly look like the model's
 * own work.
 */
export async function updateSegmentText(
  scriptId: string,
  index: number,
  text: string,
): Promise<VoSegment | null> {
  const clean = text.replace(/\s+/g, ' ').trim();
  const words = clean ? clean.split(/\s+/).length : 0;

  try {
    const row = await prisma.voiceoverSegment.update({
      where: { scriptId_index: { scriptId, index } },
      data: { script: clean, wordCount: words, editedAt: new Date() },
    });

    // Keep the script's total in step so the header does not drift.
    const total = await prisma.voiceoverSegment.aggregate({
      where: { scriptId },
      _sum: { wordCount: true },
    });
    await prisma.voiceoverScript.update({
      where: { id: scriptId },
      data: { totalWords: total._sum.wordCount ?? 0 },
    });

    return {
      index: row.index,
      startSec: row.startSec,
      endSec: row.endSec,
      onScreen: row.onScreen,
      script: row.script,
      wordBudget: row.wordBudget,
      wordCount: row.wordCount,
      imageUrl: row.imageUrl,
      editedAt: row.editedAt?.toISOString() ?? null,
    };
  } catch {
    return null;
  }
}
