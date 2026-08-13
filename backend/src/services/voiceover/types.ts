/**
 * Voiceover Studio — shared types for the video → timed VO script flow.
 */

export type VoJobPhase =
  | 'pending'
  | 'probing'
  | 'extracting'
  | 'scripting'
  | 'done'
  | 'error'
  | 'cancelled';

/** Narration style — drives tone and vocabulary in the generated script. */
export type VoTone = 'instructional' | 'marketing' | 'onboarding';


/** Public-facing job config (no secrets). */
export interface VoJobConfig {
  appName: string;
  audience: string;
  tone: VoTone;
  model: string;
  /** Which provider generated this script. */
  provider: string;
  /** Original uploaded filename. */
  videoName: string;
}

/** Technical facts read off the source video. */
export interface VideoMeta {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  sizeBytes: number;
}

/** One extracted still, with the timestamp it was taken at. */
export interface Frame {
  /** Seconds into the video. */
  at: number;
  /** True when this timestamp came from scene-change detection. */
  isSceneChange: boolean;
  /** Public URL of the saved still (null if the save failed). */
  imageUrl: string | null;
  /** base64 JPEG — in memory only, stripped before the snapshot is serialised. */
  base64?: string;
}

/** One narration segment, locked to a span of the video. */
export interface VoSegment {
  index: number;
  /** Seconds into the video. */
  startSec: number;
  endSec: number;
  /** What the viewer sees happening across this span. */
  onScreen: string;
  /** The line to be spoken — TTS-ready, no timecodes. */
  script: string;
  /** Words the segment's duration allows at the configured speaking pace. */
  wordBudget: number;
  /** Actual words in `script`. */
  wordCount: number;
  /** Still shown at the start of this segment, for the review table. */
  imageUrl: string | null;
  /** Set when a human rewrote this line. */
  editedAt?: string | null;
  /** Which stored version `script` currently holds. */
  version?: number;
  /** Every wording this line has had, newest first. */
  versions?: VoSegmentVersion[];
}

/** One stored wording of a line, with whether it still has audio on disk. */
export interface VoSegmentVersion {
  version: number;
  text: string;
  wordCount: number;
  source: 'generated' | 'edited';
  createdAt: string;
  /** Public URL of the clip rendered from this wording, when one exists. */
  audioUrl: string | null;
  voiceName: string | null;
}

/**
 * Which takes a stitched track was mixed from, as a comparable string.
 *
 * The track is a mix of specific wordings; if any line has moved to another
 * version since, the track no longer matches the script. Comparing signatures is
 * how that is detected without re-reading every clip.
 *
 * The client mirrors this format to show a "reassemble" prompt, so keep both in
 * step if it ever changes.
 */
export function timelineSignature(
  segments: Array<{ index: number; version?: number }>,
): string {
  return [...segments]
    .sort((a, b) => a.index - b.index)
    .map((s) => `${s.index}:${s.version ?? 1}`)
    .join(',');
}

/** Events streamed to the client over SSE. */
export type VoEvent =
  | { type: 'phase'; phase: VoJobPhase; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'meta'; meta: VideoMeta }
  | { type: 'frames'; count: number; sceneChanges: number }
  | { type: 'segment'; segment: VoSegment }
  | {
      type: 'done';
      /** Durable record id — the client switches to it once the run ends. */
      scriptId: string | null;
      totalSegments: number;
      totalWords: number;
      spokenSec: number;
    }
  | { type: 'error'; message: string };

export interface VoLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

/** Format seconds as m:ss for display and export. */
export function timecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Words a span of video can carry at the given narration pace. */
export function wordBudgetFor(durationSec: number, wordsPerMinute: number): number {
  return Math.max(3, Math.round((durationSec * wordsPerMinute) / 60));
}

/** Seconds a given word count takes to speak at the given pace. */
export function spokenSecondsFor(wordCount: number, wordsPerMinute: number): number {
  return (wordCount / wordsPerMinute) * 60;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
