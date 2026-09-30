/**
 * chunked-upload.service.ts — Resumable, piecewise video uploads.
 * ───────────────────────────────────────────────────────────────
 * A multi-GB walkthrough sent as one request has to survive every proxy on the
 * way (Cloudflare caps a request body at 100 MB on most plans, Traefik has read
 * timeouts) and restarts from zero on any network blip. Instead the browser
 * sends fixed-size pieces, each its own short request, appended in order to one
 * file on disk. A dropped piece is retried from the byte the server last saw.
 *
 * Upload sessions are held in memory, like voiceover jobs: a restart abandons
 * them, and the startup sweep removes their partial files.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { uploadDir } from '../../lib/upload.js';
import { logger } from '../../lib/logger.js';

/** Piece size. Kept well under Cloudflare's 100 MB per-request body cap. */
export const CHUNK_BYTES = 32 * 1024 * 1024;

/** An upload with no piece received for this long is abandoned. */
const IDLE_MS = 2 * 60 * 60 * 1000;

const PART_SUFFIX = '.part';
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|mpe?g)$/i;

interface UploadSession {
  id: string;
  userId: string;
  originalName: string;
  sizeBytes: number;
  receivedBytes: number;
  path: string;
  /** Set while a piece is being written, so two pieces can never interleave. */
  busy: boolean;
  updatedAt: number;
}

const SESSIONS = new Map<string, UploadSession>();

export interface UploadStatus {
  uploadId: string;
  sizeBytes: number;
  receivedBytes: number;
  chunkBytes: number;
  complete: boolean;
}

function status(s: UploadSession): UploadStatus {
  return {
    uploadId: s.id,
    sizeBytes: s.sizeBytes,
    receivedBytes: s.receivedBytes,
    chunkBytes: CHUNK_BYTES,
    complete: s.receivedBytes === s.sizeBytes,
  };
}

function removeFile(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (err) {
    logger.warn('voiceover: could not remove partial upload', { error: (err as Error).message });
  }
}

/** Open a session. Throws a user-facing message when the file is unacceptable. */
export function createUpload(
  userId: string,
  originalName: string,
  sizeBytes: number,
  maxMb: number,
): UploadStatus {
  if (!VIDEO_EXT.test(originalName)) {
    throw new Error('Only MP4, MOV, WebM, MKV, AVI or MPEG videos are accepted.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('A valid file size is required.');
  }
  if (sizeBytes > maxMb * 1024 * 1024) {
    throw new Error(`Video is larger than the ${maxMb} MB limit.`);
  }

  const id = randomUUID();
  // The stored name is ours, never the client's, so it cannot escape uploadDir.
  const filePath = path.join(uploadDir, `${id}${PART_SUFFIX}`);
  fs.writeFileSync(filePath, Buffer.alloc(0));

  const session: UploadSession = {
    id,
    userId,
    originalName: path.basename(originalName).slice(0, 200),
    sizeBytes,
    receivedBytes: 0,
    path: filePath,
    busy: false,
    updatedAt: Date.now(),
  };
  SESSIONS.set(id, session);
  return status(session);
}

function owned(id: string, userId: string): UploadSession {
  const s = SESSIONS.get(id);
  if (!s || s.userId !== userId) throw new Error('Upload not found or expired. Start it again.');
  return s;
}

export function getUpload(id: string, userId: string): UploadStatus {
  return status(owned(id, userId));
}

/**
 * Append one piece, streamed straight from the request to disk.
 *
 * `offset` must equal the bytes already stored; a mismatch means the client is
 * out of step (a retried piece that actually landed), and the reply tells it
 * where to resume. A piece that fails midway is truncated back off the file.
 */
export async function appendChunk(
  id: string,
  userId: string,
  offset: number,
  req: Request,
): Promise<UploadStatus> {
  const s = owned(id, userId);
  if (s.busy) throw new Error('Another piece of this upload is still being written.');
  if (offset !== s.receivedBytes) {
    const err = new Error(`Expected offset ${s.receivedBytes}.`) as Error & { resumeAt?: number };
    err.resumeAt = s.receivedBytes;
    throw err;
  }

  const remaining = s.sizeBytes - s.receivedBytes;
  const allowed = Math.min(CHUNK_BYTES, remaining);
  s.busy = true;

  try {
    const written = await new Promise<number>((resolve, reject) => {
      const out = fs.createWriteStream(s.path, { flags: 'a' });
      let bytes = 0;
      let failed = false;
      const fail = (e: Error): void => {
        if (failed) return;
        failed = true;
        req.unpipe(out);
        out.destroy();
        reject(e);
      };

      req.on('data', (buf: Buffer) => {
        bytes += buf.length;
        if (bytes > allowed) fail(new Error('Piece is larger than expected.'));
      });
      req.on('aborted', () => fail(new Error('The connection dropped mid-piece.')));
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (!failed) resolve(bytes);
      });
      req.pipe(out);
    });

    // The last piece may be short; every other piece must be full, or the
    // client and server disagree about the layout of the file.
    if (written !== allowed) throw new Error(`Piece was ${written} bytes, expected ${allowed}.`);

    s.receivedBytes += written;
    s.updatedAt = Date.now();
    return status(s);
  } catch (err) {
    // Drop whatever part of the failed piece reached the disk.
    try {
      fs.truncateSync(s.path, s.receivedBytes);
    } catch {
      /* the next piece will be rejected on offset and the client resumes */
    }
    throw err;
  } finally {
    s.busy = false;
  }
}

/**
 * Hand a finished upload to a job. The file is renamed to carry its real
 * extension (ffmpeg probes by content, but the name keeps disk contents legible)
 * and the session ends — the job now owns the file.
 */
export function takeCompletedUpload(
  id: string,
  userId: string,
): { path: string; originalName: string } {
  const s = owned(id, userId);
  if (s.busy || s.receivedBytes !== s.sizeBytes) {
    throw new Error('That upload has not finished yet.');
  }
  const ext = path.extname(s.originalName).toLowerCase() || '.mp4';
  const finalPath = path.join(uploadDir, `${s.id}${ext}`);
  fs.renameSync(s.path, finalPath);
  SESSIONS.delete(id);
  return { path: finalPath, originalName: s.originalName };
}

export function cancelUpload(id: string, userId: string): void {
  const s = SESSIONS.get(id);
  if (!s || s.userId !== userId) return;
  SESSIONS.delete(id);
  removeFile(s.path);
}

/**
 * Remove idle sessions and any `.part` file no live session owns — the latter
 * covers files left behind by a restart, since sessions do not survive one.
 */
export function sweepUploads(): void {
  const now = Date.now();
  for (const s of SESSIONS.values()) {
    if (!s.busy && now - s.updatedAt > IDLE_MS) {
      SESSIONS.delete(s.id);
      removeFile(s.path);
    }
  }
  const live = new Set([...SESSIONS.values()].map((s) => s.path));
  try {
    for (const name of fs.readdirSync(uploadDir)) {
      if (!name.endsWith(PART_SUFFIX)) continue;
      const full = path.join(uploadDir, name);
      if (!live.has(full)) removeFile(full);
    }
  } catch (err) {
    logger.warn('voiceover: upload sweep failed', { error: (err as Error).message });
  }
}
