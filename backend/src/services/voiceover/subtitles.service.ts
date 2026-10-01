/**
 * subtitles.service.ts — SRT / WebVTT captions for a voiceover script.
 * ─────────────────────────────────────────────────────────────────────
 * Cues follow the narration as it actually sounds on the assembled track (each
 * line's start, and the end measured from its rendered clip), so captions sit
 * under the same words in Premiere Pro, the browser preview or YouTube.
 *
 * Long lines are split into readable cues — at most two lines of ~42
 * characters — with the line's time shared out by character count.
 */

export type SubtitleFormat = 'srt' | 'vtt';

export interface CaptionLine {
  startSec: number;
  endSec: number;
  text: string;
}

export interface Cue extends CaptionLine {}

const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;
const MIN_CUE_SEC = 0.8;

/** Break text into cues of at most MAX_LINES × MAX_LINE_CHARS, on word boundaries. */
function chunkText(text: string): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > MAX_LINE_CHARS) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);

  const cues: string[] = [];
  for (let i = 0; i < lines.length; i += MAX_LINES) {
    cues.push(lines.slice(i, i + MAX_LINES).join('\n'));
  }
  return cues;
}

/** Turn timed narration lines into display cues, never overlapping. */
export function buildCues(lines: CaptionLine[]): Cue[] {
  const sorted = lines
    .filter((l) => l.text.trim() && l.endSec > l.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  const cues: Cue[] = [];
  for (const line of sorted) {
    const chunks = chunkText(line.text);
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    const span = line.endSec - line.startSec;
    let at = line.startSec;
    chunks.forEach((chunk, i) => {
      const end = i === chunks.length - 1 ? line.endSec : at + (span * chunk.length) / total;
      cues.push({ startSec: at, endSec: end, text: chunk });
      at = end;
    });
  }

  // Hold very short cues a little longer when there is room before the next one.
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const limit = cues[i + 1]?.startSec ?? Number.POSITIVE_INFINITY;
    if (cue.endSec - cue.startSec < MIN_CUE_SEC) {
      cue.endSec = Math.min(cue.startSec + MIN_CUE_SEC, limit);
    }
  }
  return cues;
}

/** 00:01:02,345 (SRT) or 00:01:02.345 (VTT). */
export function subtitleTime(sec: number, format: SubtitleFormat): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${format === 'srt' ? ',' : '.'}${pad(frac, 3)}`;
}

export function renderSubtitles(cues: Cue[], format: SubtitleFormat): string {
  const body = cues
    .map((cue, i) => {
      const timing = `${subtitleTime(cue.startSec, format)} --> ${subtitleTime(cue.endSec, format)}`;
      return format === 'srt' ? `${i + 1}\n${timing}\n${cue.text}` : `${timing}\n${cue.text}`;
    })
    .join('\n\n');
  return format === 'vtt' ? `WEBVTT\n\n${body}\n` : `${body}\n`;
}
