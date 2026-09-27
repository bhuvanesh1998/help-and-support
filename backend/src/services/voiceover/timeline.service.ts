/**
 * timeline.service.ts — Stitch per-line clips into one full-length track.
 * ─────────────────────────────────────────────────────────────────────
 * Per-segment clips are what you re-record; a single track is what you drop
 * under the video. Each clip is delayed to its own start timecode and the whole
 * mix is padded to the video's length, so the result lines up when laid on the
 * timeline with no manual nudging.
 *
 * Uses the bundled ffmpeg, so no system install is involved.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { env } from '../../config/env.js';
import { uploadDir } from '../../lib/upload.js';
import type { RenderedClip } from './tts.service.js';

const FFMPEG = ffmpegPath as unknown as string;

export interface TimelineInput {
  /** One entry per rendered line, in timeline order. */
  clips: Array<{ startSec: number; storagePath: string }>;
  /** Total length of the source video, so the track matches it exactly. */
  durationSec: number;
}

/**
 * Build the mixed track. Returns the stored file, ready to attach as audio of
 * kind 'timeline'.
 */
export async function buildTimeline(input: TimelineInput): Promise<RenderedClip> {
  const usable = input.clips.filter((c) => fs.existsSync(c.storagePath));
  if (usable.length === 0) {
    throw new Error('No rendered clips are available to assemble.');
  }

  const filename = `${randomUUID()}.mp3`;
  const outPath = path.join(uploadDir, filename);

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const clip of usable) args.push('-i', clip.storagePath);

  // adelay shifts each clip to its timecode; amix overlays them on one track.
  // normalize=0 keeps each line at its recorded level instead of scaling the
  // mix down by the number of inputs.
  const delays = usable
    .map((clip, i) => {
      const ms = Math.max(0, Math.round(clip.startSec * 1000));
      return `[${i}:a]adelay=${ms}|${ms}[a${i}]`;
    })
    .join(';');
  const mixInputs = usable.map((_, i) => `[a${i}]`).join('');
  const filter =
    usable.length === 1
      ? `${delays};[a0]apad[mix]`
      : `${delays};${mixInputs}amix=inputs=${usable.length}:normalize=0:dropout_transition=0[mixed];[mixed]apad[mix]`;

  args.push(
    '-filter_complex',
    filter,
    '-map',
    '[mix]',
    // apad would run forever without an explicit length; this is what makes the
    // track the same duration as the video.
    '-t',
    Math.max(1, input.durationSec).toFixed(2),
    '-c:a',
    'libmp3lame',
    '-q:a',
    '4',
    outPath,
  );

  await new Promise<void>((resolve, reject) => {
    execFile(
      FFMPEG,
      args,
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err && !fs.existsSync(outPath)) {
          reject(new Error(`Could not assemble the track: ${stderr || err.message}`.slice(0, 300)));
          return;
        }
        resolve();
      },
    );
  });

  if (!fs.existsSync(outPath)) {
    throw new Error('Could not assemble the track: ffmpeg produced no output.');
  }

  return {
    filename,
    storagePath: outPath,
    publicUrl: `${env.publicBaseUrl}/uploads/${filename}`,
    sizeBytes: fs.statSync(outPath).size,
  };
}
