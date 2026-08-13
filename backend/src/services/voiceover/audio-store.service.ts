/**
 * audio-store.service.ts — Stored narration clips for a script.
 * ────────────────────────────────────────────────────────────
 * Audio is keyed by (script, segment index, segment version). Re-rendering the
 * same wording replaces exactly that clip; rewriting a line renders under a new
 * version and the previous recording stays, which is what lets an edit be undone
 * without paying to record the old wording again.
 *
 * The stitched timeline is derived rather than spoken, so it lives at
 * segmentIndex -1 / version 0. Each tone variant is its own script and carries
 * its own audio set.
 */

import { prisma } from '../../lib/prisma.js';
import { removeClipFile, type RenderedClip } from './tts.service.js';

/** The full-length stitched track is stored at this index. */
export const TIMELINE_INDEX = -1;

/** Version used for clips that are not spoken from a wording (the timeline). */
export const DERIVED_VERSION = 0;

export interface AudioClip {
  kind: string;
  segmentIndex: number;
  /** Which wording of the line this clip speaks; 0 for the stitched track. */
  segmentVersion: number;
  voiceId: string;
  voiceName: string;
  modelId: string;
  publicUrl: string;
  sizeBytes: number;
  createdAt: string;
}

export async function listAudio(scriptId: string): Promise<AudioClip[]> {
  const rows = await prisma.voiceoverAudio.findMany({
    where: { scriptId },
    orderBy: { segmentIndex: 'asc' },
  });
  return rows.map((r) => ({
    kind: r.kind,
    segmentIndex: r.segmentIndex,
    segmentVersion: r.segmentVersion,
    voiceId: r.voiceId,
    voiceName: r.voiceName,
    modelId: r.modelId,
    publicUrl: r.publicUrl,
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Paths needed to build a zip or clean up on delete. */
export async function listAudioFiles(
  scriptId: string,
  kind?: 'segment' | 'timeline',
): Promise<
  Array<{ segmentIndex: number; segmentVersion: number; storagePath: string; filename: string }>
> {
  return prisma.voiceoverAudio.findMany({
    where: { scriptId, ...(kind ? { kind } : {}) },
    orderBy: [{ segmentIndex: 'asc' }, { segmentVersion: 'asc' }],
    select: { segmentIndex: true, segmentVersion: true, storagePath: true, filename: true },
  });
}

/**
 * Remove clips for one segment. With no version, every recording of that line
 * goes — used for the derived timeline, which has exactly one.
 */
export async function deleteClip(
  scriptId: string,
  segmentIndex: number,
  segmentVersion?: number,
): Promise<void> {
  const where = {
    scriptId,
    segmentIndex,
    ...(segmentVersion === undefined ? {} : { segmentVersion }),
  };
  const rows = await prisma.voiceoverAudio.findMany({ where, select: { storagePath: true } });
  if (rows.length === 0) return;

  await prisma.voiceoverAudio.deleteMany({ where });
  for (const row of rows) removeClipFile(row.storagePath);
}

/**
 * Store a rendered clip against one wording of a line.
 *
 * Re-recording the same wording replaces that clip (and deletes the superseded
 * file, so takes do not pile up on disk); recording a different version adds a
 * row and leaves earlier recordings intact.
 */
export async function saveClip(
  scriptId: string,
  segmentIndex: number,
  voice: { voiceId: string; voiceName: string; modelId: string },
  clip: RenderedClip,
  kind: 'segment' | 'timeline' = 'segment',
  segmentVersion = 1,
): Promise<AudioClip> {
  const key = {
    scriptId_segmentIndex_segmentVersion: { scriptId, segmentIndex, segmentVersion },
  };

  const existing = await prisma.voiceoverAudio.findUnique({
    where: key,
    select: { storagePath: true },
  });

  const row = await prisma.voiceoverAudio.upsert({
    where: key,
    update: {
      kind,
      voiceId: voice.voiceId,
      voiceName: voice.voiceName,
      modelId: voice.modelId,
      filename: clip.filename,
      storagePath: clip.storagePath,
      publicUrl: clip.publicUrl,
      sizeBytes: clip.sizeBytes,
    },
    create: {
      scriptId,
      kind,
      segmentIndex,
      segmentVersion,
      voiceId: voice.voiceId,
      voiceName: voice.voiceName,
      modelId: voice.modelId,
      filename: clip.filename,
      storagePath: clip.storagePath,
      publicUrl: clip.publicUrl,
      sizeBytes: clip.sizeBytes,
    },
  });

  if (existing && existing.storagePath !== clip.storagePath) {
    removeClipFile(existing.storagePath);
  }

  return {
    kind: row.kind,
    segmentIndex: row.segmentIndex,
    segmentVersion: row.segmentVersion,
    voiceId: row.voiceId,
    voiceName: row.voiceName,
    modelId: row.modelId,
    publicUrl: row.publicUrl,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Delete every clip for a script, files included. */
export async function deleteAudio(scriptId: string): Promise<number> {
  const rows = await prisma.voiceoverAudio.findMany({
    where: { scriptId },
    select: { storagePath: true },
  });
  const result = await prisma.voiceoverAudio.deleteMany({ where: { scriptId } });
  for (const row of rows) removeClipFile(row.storagePath);
  return result.count;
}
