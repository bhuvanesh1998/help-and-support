import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { VoAudioClip, VoSegment, VoSegmentVersion } from '../../../../core/models/admin';

/**
 * The timed script — shared by the live generate page and the saved script detail
 * page so the two can never drift apart.
 *
 * Laid out as one card per line rather than a table: a line carries a still, its
 * on-screen note, editable narration, a take, and a version history, and none of
 * that survives being squeezed into a table cell.
 *
 * Timecodes here are an editing reference only; the copy buttons and the ZIP are
 * what feed a text-to-speech engine, since TTS reads timecodes aloud as numbers.
 */
@Component({
  selector: 'ha-script-table',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './script-table.html',
  styleUrl: './script-table.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScriptTable {
  readonly segments = input.required<VoSegment[]>();
  /** Take for each line's current wording, when one has been rendered. */
  readonly audio = input<Map<number, VoAudioClip>>(new Map());
  /** Whether lines can be hand-edited here. */
  readonly editable = input(false);
  /** Segment currently rendering audio, so its card can show progress. */
  readonly renderingIndex = input<number | null>(null);

  readonly saveLine = output<{ index: number; script: string }>();
  readonly renderLine = output<number>();
  readonly restoreVersion = output<{ index: number; version: number }>();

  readonly copiedIndex = signal<number | null>(null);
  /** Segment being edited; `draft` holds the working text. */
  readonly editingIndex = signal<number | null>(null);
  /** Segment whose version history is expanded. */
  readonly historyIndex = signal<number | null>(null);
  draft = '';

  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  readonly overBudgetCount = computed(
    () => this.segments().filter((s) => s.wordCount > s.wordBudget).length,
  );

  readonly recordedCount = computed(
    () => this.segments().filter((s) => this.audio().has(s.index)).length,
  );

  readonly spokenCount = computed(() => this.segments().filter((s) => s.script.trim()).length);

  /** Lines whose earlier wording still has a take on file. */
  readonly withHistoryCount = computed(
    () => this.segments().filter((s) => (s.versions?.length ?? 0) > 1).length,
  );

  clipFor(index: number): VoAudioClip | undefined {
    return this.audio().get(index);
  }

  versionsFor(segment: VoSegment): VoSegmentVersion[] {
    return segment.versions ?? [];
  }

  hasHistory(segment: VoSegment): boolean {
    return this.versionsFor(segment).length > 1;
  }

  /** Older wordings that still have audio — the ones worth restoring. */
  recoverableTakes(segment: VoSegment): number {
    return this.versionsFor(segment).filter(
      (v) => v.version !== (segment.version ?? 1) && v.audioUrl,
    ).length;
  }

  isCurrent(segment: VoSegment, version: VoSegmentVersion): boolean {
    return (segment.version ?? 1) === version.version;
  }

  toggleHistory(index: number): void {
    this.historyIndex.update((open) => (open === index ? null : index));
  }

  /** Live word count while editing, so the budget is visible as you type. */
  draftWords(): number {
    const trimmed = this.draft.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  /** How full the budget is, for the meter under the line. */
  budgetPercent(segment: VoSegment): number {
    if (segment.wordBudget <= 0) return 0;
    return Math.min(100, Math.round((segment.wordCount / segment.wordBudget) * 100));
  }

  startEdit(segment: VoSegment): void {
    this.draft = segment.script;
    this.editingIndex.set(segment.index);
  }

  cancelEdit(): void {
    this.editingIndex.set(null);
    this.draft = '';
  }

  commitEdit(): void {
    const index = this.editingIndex();
    const text = this.draft.trim();
    if (index === null || !text) return;
    this.saveLine.emit({ index, script: text });
    this.editingIndex.set(null);
  }

  restore(segment: VoSegment, version: VoSegmentVersion): void {
    if (this.isCurrent(segment, version)) return;
    this.restoreVersion.emit({ index: segment.index, version: version.version });
  }

  timecode(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  duration(segment: VoSegment): string {
    return `${(segment.endSec - segment.startSec).toFixed(1)}s`;
  }

  overBudget(segment: VoSegment): boolean {
    return segment.wordCount > segment.wordBudget;
  }

  /** Short relative age, so a history entry reads without a full timestamp. */
  age(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const minutes = Math.round((Date.now() - then) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  async copyScript(segment: VoSegment): Promise<void> {
    try {
      await navigator.clipboard.writeText(segment.script);
      this.flashCopied(segment.index);
    } catch {
      /* clipboard blocked — the text is still selectable */
    }
  }

  /** Copy the whole read-through, for a single continuous take. */
  async copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.segments().map((s) => s.script).join('\n\n'));
      this.flashCopied(-1);
    } catch {
      /* clipboard blocked */
    }
  }

  private flashCopied(index: number): void {
    this.copiedIndex.set(index);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copiedIndex.set(null), 1600);
  }
}
