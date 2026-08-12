import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { VoScriptFilters, VoScriptSummary } from '../../../../core/models/admin';

/**
 * Voiceover library — every generated script as a card, searchable and
 * filterable, with generation on its own page.
 *
 * Cards group by source video: a re-toned run is a variant of the original, so
 * one recording with three tones reads as one entry with three tones rather than
 * three unrelated rows.
 */
@Component({
  selector: 'ha-voiceover-library',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
  ],
  templateUrl: './voiceover-library.html',
  styleUrl: './voiceover-library.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceoverLibrary implements OnInit, OnDestroy {
  private readonly api = inject(AdminApiService);

  readonly scripts = signal<VoScriptSummary[]>([]);
  readonly filters = signal<VoScriptFilters>({ tones: [], providers: [], statuses: [] });
  readonly loading = signal(true);
  readonly error = signal('');

  search = '';
  status = '';
  tone = '';
  provider = '';

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** True while any card is mid-generation, which drives the auto-refresh. */
  readonly hasRunning = computed(() => this.scripts().some((s) => s.status === 'running'));

  readonly anyFilterActive = computed(
    () => !!(this.search.trim() || this.status || this.tone || this.provider),
  );

  /**
   * Cards grouped by source video, so one recording narrated in three tones
   * reads as one entry with three cards rather than three unrelated rows.
   */
  readonly groups = computed(() => {
    const byVideo = new Map<string, VoScriptSummary[]>();
    for (const script of this.scripts()) {
      const list = byVideo.get(script.videoName);
      if (list) list.push(script);
      else byVideo.set(script.videoName, [script]);
    }
    return [...byVideo.entries()].map(([videoName, scripts]) => ({ videoName, scripts }));
  });

  /** Collapsed group headings, keyed by video name. */
  readonly collapsed = signal<Set<string>>(new Set());

  toggleGroup(videoName: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(videoName)) next.delete(videoName);
      else next.add(videoName);
      return next;
    });
  }

  isCollapsed(videoName: string): boolean {
    return this.collapsed().has(videoName);
  }

  ngOnInit(): void {
    this.load();
    // A run started on the generate page keeps progressing after navigating
    // here, so refresh periodically while anything is still running.
    this.pollTimer = setInterval(() => {
      if (this.hasRunning()) this.load(true);
    }, 10_000);
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.api
      .listVoiceoverScripts({
        search: this.search.trim(),
        status: this.status,
        tone: this.tone,
        provider: this.provider,
      })
      .subscribe({
        next: (res) => {
          this.scripts.set(res.scripts);
          this.filters.set(res.filters);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load the script library.');
          this.loading.set(false);
        },
      });
  }

  /** Debounced so typing doesn't fire a request per keystroke. */
  onSearchInput(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(true), 300);
  }

  clearFilters(): void {
    this.search = '';
    this.status = '';
    this.tone = '';
    this.provider = '';
    this.load();
  }

  deleteScript(script: VoScriptSummary, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.api.deleteVoiceoverScript(script.id).subscribe({
      next: () => this.scripts.update((list) => list.filter((s) => s.id !== script.id)),
      error: () => this.error.set('Could not delete that script.'),
    });
  }

  when(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleString(undefined, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
  }

  timecode(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
}
