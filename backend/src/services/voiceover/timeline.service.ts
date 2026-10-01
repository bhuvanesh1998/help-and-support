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
import ffprobeStatic from 'ffprobe-static';
import { env } from '../../config/env.js';
import { uploadDir } from '../../lib/upload.js';
import type { RenderedClip } from './tts.service.js';

const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = ffprobeStatic.path;

/** Fastest a line may be sped up to fit its slot before it is trimmed instead. */
export const MAX_TEMPO = 1.25;
/** Short fade on a trimmed line so the cut is not a click. */
const FADE_SEC = 0.12;

/** Length of an audio file in seconds, or 0 when it cannot be read. */
export function probeAudioSeconds(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
      { timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        const sec = Number(String(stdout).trim());
        resolve(!err && Number.isFinite(sec) && sec > 0 ? sec : 0);
      },
    );
  });
}

/** Where one line actually sounds on the finished track. */
export interface PlacedClip {
  startSec: number;
  /** When the line stops sounding — never past the next line's start. */
  endSec: number;
  /** Playback speed applied to fit the slot (1 = untouched). */
  tempo: number;
  /** True when even at MAX_TEMPO the line was too long and its tail was cut. */
  trimmed: boolean;
}

/**
 * Fit each clip into its slot: the time from its own start to the next line's
 * start (or the end of the video). A clip that runs long is sped up, up to
 * MAX_TEMPO, and anything still over is trimmed with a short fade, so no line
 * ever spills into the next one and the timing cannot drift as the video goes on.
 */
export function placeClips(
  clips: Array<{ startSec: number; durationSec: number }>,
  videoSec: number,
): PlacedClip[] {
  return clips.map((clip, i) => {
    const next = clips[i + 1]?.startSec ?? videoSec;
    const slot = Math.max(0.3, Math.min(next, videoSec) - clip.startSec);
    const spoken = clip.durationSec > 0 ? clip.durationSec : slot;
    const tempo = spoken > slot ? Math.min(MAX_TEMPO, spoken / slot) : 1;
    const fitted = spoken / tempo;
    return {
      startSec: clip.startSec,
      endSec: clip.startSec + Math.min(fitted, slot),
      tempo: Number(tempo.toFixed(3)),
      trimmed: fitted > slot + 0.01,
    };
  });
}

export interface TimelineInput {
  /** One entry per rendered line, in timeline order. */
  clips: Array<{ startSec: number; storagePath: string; durationSec?: number }>;
  /** Total length of the source video, so the track matches it exactly. */
  durationSec: number;
}

/**
 * Build the mixed track. Returns the stored file, ready to attach as audio of
 * kind 'timeline'.
 */
export async function buildTimeline(
  input: TimelineInput,
): Promise<RenderedClip & { placed: PlacedClip[] }> {
  const usable = input.clips
    .filter((c) => fs.existsSync(c.storagePath))
    .sort((a, b) => a.startSec - b.startSec);
  if (usable.length === 0) {
    throw new Error('No rendered clips are available to assemble.');
  }

  const filename = `${randomUUID()}.mp3`;
  const outPath = path.join(uploadDir, filename);

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const clip of usable) args.push('-i', clip.storagePath);

  const durations = await Promise.all(
    usable.map((c) => (c.durationSec ? Promise.resolve(c.durationSec) : probeAudioSeconds(c.storagePath))),
  );
  const placed = placeClips(
    usable.map((c, i) => ({ startSec: c.startSec, durationSec: durations[i] ?? 0 })),
    input.durationSec,
  );

  // Per clip: resample to one rate (mixed-rate inputs are what make amix drift),
  // reset timestamps, strip the encoder's leading silence so speech starts on its
  // timecode, speed up to fit the slot, cut at the slot end, then delay into place.
  // normalize=0 on amix keeps each line at its recorded level. The final asetpts
  // rebuilds timestamps from the sample count: after atempo/afade the mp3 muxer
  // otherwise rejects them and writes a track only ~1 s long.
  const delays = usable
    .map((_, i) => {
      const p = placed[i]!;
      const len = Math.max(0.1, p.endSec - p.startSec);
      const ms = Math.max(0, Math.round(p.startSec * 1000));
      const chain = [
        'aresample=44100',
        'asetpts=PTS-STARTPTS',
        'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02',
        ...(p.tempo > 1 ? [`atempo=${p.tempo}`] : []),
        `atrim=end=${len.toFixed(3)}`,
        ...(p.trimmed ? [`afade=t=out:st=${Math.max(0, len - FADE_SEC).toFixed(3)}:d=${FADE_SEC}`] : []),
        `adelay=${ms}|${ms}`,
      ].join(',');
      return `[${i}:a]${chain}[a${i}]`;
    })
    .join(';');
  const mixInputs = usable.map((_, i) => `[a${i}]`).join('');
  const filter =
    usable.length === 1
      ? `${delays};[a0]apad,asetpts=N/SR/TB[mix]`
      : `${delays};${mixInputs}amix=inputs=${usable.length}:normalize=0:dropout_transition=0[mixed];[mixed]apad,asetpts=N/SR/TB[mix]`;

  args.push(
    '-filter_complex',
    filter,
    '-map',
    '[mix]',
    // apad would run forever without an explicit length; this is what makes the
    // track the same duration as the video.
    '-t',
    Math.max(1, input.durationSec).toFixed(2),
    '-ar',
    '44100',
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
    placed,
  };
}
