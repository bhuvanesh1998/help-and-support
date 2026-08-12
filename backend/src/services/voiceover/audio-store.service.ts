/**
 * audio-store.service.ts — Stored narration clips for a script.
 * ────────────────────────────────────────────────────────────
 * Audio is keyed by (script, segment index), so re-rendering one line replaces
 * exactly that clip and leaves the rest alone. Each tone variant is its own
 * script, so it carries its own audio set rather than sharing one.
 */

import { prisma } from '../../lib/prisma.js';
import { removeClipFile, type RenderedClip } from './tts.service.js';

/** The full-length stitched track is stored at this index. */
export const TIMELINE_INDEX = -1;

export interface AudioClip {
  kind: string;
  segmentIndex: number;
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
): Promise<Array<{ segmentIndex: number; storagePath: string; filename: string }>> {
  return prisma.voiceoverAudio.findMany({
    where: { scriptId, ...(kind ? { kind } : {}) },
    orderBy: { segmentIndex: 'asc' },
    select: { segmentIndex: true, storagePath: true, filename: true },
  });
}

/** Remove one segment's clip — used when its text is rewritten. */
export async function deleteClip(scriptId: string, segmentIndex: number): Promise<void> {
  const row = await prisma.voiceoverAudio.findUnique({
    where: { scriptId_segmentIndex: { scriptId, segmentIndex } },
    select: { storagePath: true },
  });
  if (!row) return;
  await prisma.voiceoverAudio.deleteMany({ where: { scriptId, segmentIndex } });
  removeClipFile(row.storagePath);
}

/**
 * Store a rendered clip, replacing any existing one for the same segment. The
 * superseded file is deleted so re-renders do not accumulate on disk.
 */
export async function saveClip(
  scriptId: string,
  segmentIndex: number,
  voice: { voiceId: string; voiceName: string; modelId: string },
  clip: RenderedClip,
  kind: 'segment' | 'timeline' = 'segment',
): Promise<AudioClip> {
  const existing = await prisma.voiceoverAudio.findUnique({
    where: { scriptId_segmentIndex: { scriptId, segmentIndex } },
    select: { storagePath: true },
  });

  const row = await prisma.voiceoverAudio.upsert({
    where: { scriptId_segmentIndex: { scriptId, segmentIndex } },
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
