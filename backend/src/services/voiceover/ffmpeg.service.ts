/**
 * ffmpeg.service.ts — Video probing and frame extraction.
 * ────────────────────────────────────────────────────────
 * Binaries ship with the `ffmpeg-static` / `ffprobe-static` packages, so no
 * system ffmpeg install is required — the same code path works locally and in
 * the deploy container.
 *
 * Timestamps come from ffmpeg's scene-change filter, so the generated script's
 * timecodes land on real UI transitions rather than an arbitrary grid.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { logger } from '../../lib/logger.js';
import type { VoiceoverSettings } from './settings.service.js';
import type { Frame, VideoMeta } from './types.js';

const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = ffprobeStatic.path;

export class FfmpegError extends Error {}

function run(bin: string, args: string[], signal: AbortSignal, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { signal, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        // ffmpeg writes its progress and filter output to stderr even on success.
        if (err && !stdout && !stderr) {
          reject(new FfmpegError(err.message));
          return;
        }
        if (err && (err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
          reject(new FfmpegError('Cancelled'));
          return;
        }
        resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}

/** Read duration, frame rate and resolution off the source file. */
export async function probeVideo(filePath: string, signal: AbortSignal): Promise<VideoMeta> {
  const out = await run(
    FFPROBE,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate:format=duration,size',
      '-of', 'json',
      filePath,
    ],
    signal,
    60_000,
  );

  const jsonStart = out.indexOf('{');
  if (jsonStart === -1) throw new FfmpegError('Could not read video metadata — the file may not be a valid video.');

  const parsed = JSON.parse(out.slice(jsonStart, out.lastIndexOf('}') + 1)) as {
    streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string }>;
    format?: { duration?: string; size?: string };
  };

  const stream = parsed.streams?.[0];
  if (!stream) throw new FfmpegError('No video stream found in the uploaded file.');

  // avg_frame_rate arrives as a rational string, e.g. "30000/1001".
  const [num = 0, den = 1] = (stream.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;
  const durationSec = Number(parsed.format?.duration ?? 0);

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new FfmpegError('Video duration could not be determined.');
  }

  return {
    durationSec,
    fps: Number(fps.toFixed(2)),
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    sizeBytes: Number(parsed.format?.size ?? 0),
  };
}

/**
 * Timestamps of scene changes, via ffmpeg's `select` filter. Decodes the whole
 * file but writes no output, so cost is CPU only.
 */
export async function detectSceneChanges(
  filePath: string,
  sceneThreshold: number,
  signal: AbortSignal,
): Promise<number[]> {
  const out = await run(
    FFMPEG,
    [
      '-hide_banner',
      '-i', filePath,
      '-filter_complex',
      `select='gt(scene,${sceneThreshold})',metadata=print:file=-`,
      '-an', '-f', 'null', '-',
    ],
    signal,
  );

  const times: number[] = [];
  for (const line of out.split('\n')) {
    // metadata=print emits: frame:N pts:N pts_time:12.345
    const match = line.match(/pts_time:([0-9]+(?:\.[0-9]+)?)/);
    if (match?.[1]) times.push(Number(match[1]));
  }
  return times.sort((a, b) => a - b);
}

/**
 * Build the timestamps to sample: every scene change, plus a uniform grid so
 * long static stretches are still covered, thinned to `maxFrames`.
 */
export function planFrameTimes(
  durationSec: number,
  sceneChanges: number[],
  maxFrames: number,
  minGapSec: number,
): Array<{ at: number; isSceneChange: boolean }> {
  const candidates = new Map<number, boolean>();

  // Always open on the first frame.
  candidates.set(0, false);
  for (const at of sceneChanges) {
    if (at > 0 && at < durationSec) candidates.set(Number(at.toFixed(2)), true);
  }

  // Uniform grid fills gaps where nothing visually changed.
  const gridStep = Math.max(minGapSec, durationSec / Math.max(1, maxFrames));
  for (let at = gridStep; at < durationSec; at += gridStep) {
    const rounded = Number(at.toFixed(2));
    if (!candidates.has(rounded)) candidates.set(rounded, false);
  }

  // Enforce the minimum gap, preferring scene changes when two marks collide.
  const sorted = [...candidates.entries()]
    .map(([at, isSceneChange]) => ({ at, isSceneChange }))
    .sort((a, b) => a.at - b.at);

  const spaced: Array<{ at: number; isSceneChange: boolean }> = [];
  for (const candidate of sorted) {
    const previous = spaced[spaced.length - 1];
    if (!previous) {
      spaced.push(candidate);
      continue;
    }
    if (candidate.at - previous.at >= minGapSec) {
      spaced.push(candidate);
    } else if (candidate.isSceneChange && !previous.isSceneChange) {
      // A real transition outranks a grid sample at effectively the same moment.
      spaced[spaced.length - 1] = candidate;
    }
  }

  if (spaced.length <= maxFrames) return spaced;

  // Over budget: keep the first frame and every scene change we can, then
  // backfill with evenly spread grid samples.
  const sceneFrames = spaced.filter((f) => f.isSceneChange);
  const kept = [spaced[0]!, ...sceneFrames.slice(0, maxFrames - 1)].sort((a, b) => a.at - b.at);

  if (kept.length < maxFrames) {
    const gridFrames = spaced.filter((f) => !f.isSceneChange && f.at > 0);
    const room = maxFrames - kept.length;
    const stride = Math.max(1, Math.ceil(gridFrames.length / room));
    for (let i = 0; i < gridFrames.length && kept.length < maxFrames; i += stride) {
      kept.push(gridFrames[i]!);
    }
    kept.sort((a, b) => a.at - b.at);
  }

  // De-duplicate in case a scene change and a grid sample rounded together.
  return kept.filter((f, i) => i === 0 || f.at !== kept[i - 1]!.at);
}

/**
 * Extract one downscaled JPEG per planned timestamp. Seeks per frame rather
 * than decoding once, which is far faster on long videos.
 */
export async function extractFrames(
  filePath: string,
  times: Array<{ at: number; isSceneChange: boolean }>,
  settings: Pick<VoiceoverSettings, 'frameWidth' | 'frameQuality'>,
  signal: AbortSignal,
  onFrame?: (frame: Frame) => void,
): Promise<Frame[]> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-vo-'));
  const frames: Frame[] = [];

  try {
    for (const { at, isSceneChange } of times) {
      if (signal.aborted) throw new FfmpegError('Cancelled');

      const outPath = path.join(workDir, `${randomUUID()}.jpg`);
      try {
        await run(
          FFMPEG,
          [
            '-hide_banner',
            // -ss before -i seeks by keyframe: much faster, accurate enough at our sample spacing.
            '-ss', at.toFixed(2),
            '-i', filePath,
            '-frames:v', '1',
            '-vf', `scale=${settings.frameWidth}:-2:flags=lanczos`,
            '-q:v', String(settings.frameQuality),
            '-y', outPath,
          ],
          signal,
          60_000,
        );

        if (!fs.existsSync(outPath)) continue;
        const buffer = fs.readFileSync(outPath);
        if (buffer.length === 0) continue;

        const frame: Frame = {
          at,
          isSceneChange,
          imageUrl: null,
          base64: buffer.toString('base64'),
        };
        frames.push(frame);
        onFrame?.(frame);
      } catch (err) {
        if (signal.aborted) throw err;
        logger.warn('voiceover: frame extraction failed', {
          at,
          error: (err as Error).message,
        });
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (frames.length === 0) {
    throw new FfmpegError('No frames could be extracted from the video.');
  }
  return frames;
}
