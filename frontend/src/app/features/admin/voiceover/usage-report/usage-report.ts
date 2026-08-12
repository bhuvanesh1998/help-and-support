import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { VoUsageBreakdown, VoUsageReport } from '../../../../core/models/admin';

/** Selectable report windows. */
const WINDOWS = [7, 30, 90, 365] as const;

/** A breakdown table's shape, so the template renders all four identically. */
interface Section {
  title: string;
  hint: string;
  icon: string;
  /** Column header for the grouping key. */
  label: string;
  rows: VoUsageBreakdown[];
}

const KIND_LABELS: Record<string, string> = {
  script: 'Script generation',
  tts: 'Narration audio',
  sample: 'Voice samples',
};

/**
 * Voiceover usage report — what the studio has consumed.
 *
 * Reported in provider units (tokens for vision, characters for text-to-speech)
 * rather than money. Rates differ per account and change over time, so a figure
 * computed from hardcoded prices would read as authoritative while being wrong;
 * the reader applies their own rates to these numbers.
 */
@Component({
  selector: 'ha-usage-report',
  standalone: true,
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  templateUrl: './usage-report.html',
  styleUrl: './usage-report.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsageReport implements OnInit {
  private readonly api = inject(AdminApiService);

  readonly windows = WINDOWS;
  readonly days = signal<number>(30);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly report = signal<VoUsageReport | null>(null);

  /** Total tokens, the headline number for vision spend. */
  readonly totalTokens = computed(() => {
    const t = this.report()?.totals;
    return t ? t.inputTokens + t.outputTokens : 0;
  });

  readonly hasData = computed(() => (this.report()?.totals.calls ?? 0) > 0);

  readonly sections = computed<Section[]>(() => {
    const r = this.report();
    if (!r) return [];
    return [
      {
        title: 'By provider',
        hint: 'Which account each call was billed to.',
        icon: 'smart_toy',
        label: 'Provider',
        rows: r.byProvider,
      },
      {
        title: 'By model',
        hint: 'Heaviest models first — the usual place a cost surprise hides.',
        icon: 'memory',
        label: 'Model',
        rows: r.byModel,
      },
      {
        title: 'By activity',
        hint: 'Script generation is tokens; narration and samples are characters.',
        icon: 'category',
        label: 'Activity',
        rows: r.byKind.map((row) => ({ ...row, key: KIND_LABELS[row.key] ?? row.key })),
      },
    ];
  });

  /** Day rows with a bar width relative to the busiest day. */
  readonly dayRows = computed(() => {
    const rows = this.report()?.byDay ?? [];
    const peak = rows.reduce((max, r) => Math.max(max, this.unitsOf(r)), 0);
    return rows.map((r) => ({
      ...r,
      units: this.unitsOf(r),
      // A zero peak would divide by zero; an all-empty window shows flat bars.
      percent: peak > 0 ? Math.round((this.unitsOf(r) / peak) * 100) : 0,
    }));
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.getVoiceoverUsage(this.days()).subscribe({
      next: (report) => {
        this.report.set(report);
        this.loading.set(false);
      },
      error: (err: { error?: { message?: string } }) => {
        this.error.set(err.error?.message ?? 'Could not load the usage report.');
        this.loading.set(false);
      },
    });
  }

  setWindow(days: number): void {
    if (days === this.days()) return;
    this.days.set(days);
    this.load();
  }

  /** Billable units for a row, tokens and characters together. */
  unitsOf(row: VoUsageBreakdown): number {
    return row.inputTokens + row.outputTokens + row.characters;
  }

  windowLabel(days: number): string {
    if (days === 365) return 'Last 12 months';
    if (days === 7) return 'Last 7 days';
    return `Last ${days} days`;
  }

  /** Compact numbers so a wide table stays scannable. */
  compact(value: number): string {
    if (value < 1000) return String(value);
    if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  dayLabel(iso: string): string {
    const [, month, day] = iso.split('-');
    return `${day}/${month}`;
  }
}
