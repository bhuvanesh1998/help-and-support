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
import { MatTooltipModule } from '@angular/material/tooltip';
import type { VoAudioClip, VoSegment } from '../../../../core/models/admin';

/**
 * The timed script table — shared by the live generate page and the saved
 * script detail page so the two can never drift apart.
 *
 * Timecodes here are an editing reference only; the per-segment copy buttons and
 * the ZIP are what feed a text-to-speech engine, since TTS reads timecodes aloud
 * as numbers.
 */
@Component({
  selector: 'ha-script-table',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatTooltipModule],
  templateUrl: './script-table.html',
  styleUrl: './script-table.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScriptTable {
  readonly segments = input.required<VoSegment[]>();
  /** Rendered clips by segment index, when audio exists. */
  readonly audio = input<Map<number, VoAudioClip>>(new Map());
  /** Whether lines can be hand-edited here. */
  readonly editable = input(false);
  /** Segment currently rendering audio, so its row can show progress. */
  readonly renderingIndex = input<number | null>(null);

  readonly saveLine = output<{ index: number; script: string }>();
  readonly renderLine = output<number>();

  readonly copiedIndex = signal<number | null>(null);
  /** Segment being edited; `draft` holds the working text. */
  readonly editingIndex = signal<number | null>(null);
  draft = '';

  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  readonly overBudgetCount = computed(
    () => this.segments().filter((s) => s.wordCount > s.wordBudget).length,
  );

  clipFor(index: number): VoAudioClip | undefined {
    return this.audio().get(index);
  }

  /** Live word count while editing, so the budget is visible as you type. */
  draftWords(): number {
    const trimmed = this.draft.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
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

  async copyScript(segment: VoSegment): Promise<void> {
    try {
      await navigator.clipboard.writeText(segment.script);
      this.copiedIndex.set(segment.index);
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copiedIndex.set(null), 1600);
    } catch {
      /* clipboard blocked — the text is still selectable in the table */
    }
  }

  /** Copy the whole read-through, for a single continuous take. */
  async copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.segments().map((s) => s.script).join('\n\n'));
      this.copiedIndex.set(-1);
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copiedIndex.set(null), 1600);
    } catch {
      /* clipboard blocked */
    }
  }
}
