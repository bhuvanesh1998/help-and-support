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
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import type {
  VideoMeta,
  VoiceoverConfig,
  VoiceoverEvent,
  VoJobPhase,
  VoSegment,
  VoTone,
} from '../../../../core/models/admin';

interface ToneOption {
  value: VoTone;
  label: string;
  hint: string;
}

/**
 * Voiceover Studio — upload a walkthrough video, get a min:sec-locked
 * narration script plus TTS-ready segment text.
 *
 * The timed table is the editing reference; the per-segment text is what goes
 * to text-to-speech. They are deliberately separate: a TTS engine reads
 * timecodes aloud as numbers, so the two must never be pasted as one blob.
 */
@Component({
  selector: 'ha-voiceover-studio',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  templateUrl: './voiceover-studio.html',
  styleUrl: './voiceover-studio.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceoverStudio implements OnInit, OnDestroy {
  private readonly api = inject(AdminApiService);
  private readonly auth = inject(AuthStore);

  // ── Form state ────────────────────────────────────────────────────────────
  appName = '';
  audience = 'End users of the application';
  tone: VoTone = 'instructional';

  readonly toneOptions: ToneOption[] = [
    { value: 'instructional', label: 'Instructional', hint: 'Teach the steps — second person, imperative' },
    { value: 'marketing', label: 'Marketing', hint: 'Lead with outcome and the pain removed' },
    { value: 'onboarding', label: 'Onboarding', hint: 'Welcome a first-time user, explain the why' },
  ];

  readonly file = signal<File | null>(null);
  readonly config = signal<VoiceoverConfig | null>(null);

  // ── Job state ─────────────────────────────────────────────────────────────
  readonly jobId = signal('');
  readonly phase = signal<VoJobPhase | 'idle'>('idle');
  readonly phaseMessage = signal('');
  readonly meta = signal<VideoMeta | null>(null);
  readonly segments = signal<VoSegment[]>([]);
  readonly logs = signal<Array<{ level: string; message: string }>>([]);
  readonly error = signal('');
  readonly startError = signal('');

  readonly copiedIndex = signal<number | null>(null);

  private source: EventSource | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Derived ───────────────────────────────────────────────────────────────
  readonly running = computed(() => {
    const p = this.phase();
    return p === 'pending' || p === 'probing' || p === 'extracting' || p === 'scripting';
  });

  readonly hasResult = computed(() => this.segments().length > 0);

  readonly totalWords = computed(() =>
    this.segments().reduce((sum, s) => sum + s.wordCount, 0),
  );

  readonly overBudgetCount = computed(
    () => this.segments().filter((s) => s.wordCount > s.wordBudget).length,
  );

  /** Spoken length at the server's configured pace — compare against video length. */
  readonly spokenSec = computed(() => {
    const wpm = this.config()?.settings.wordsPerMinute ?? 150;
    return Math.round((this.totalWords() / wpm) * 60);
  });

  readonly canStart = computed(
    () =>
      !!this.file() &&
      this.appName.trim().length > 0 &&
      !this.running() &&
      !this.providerKeyMissing(),
  );

  /** Friendly name of the provider that will generate the script. */
  readonly providerLabel = computed(() => {
    const cfg = this.config();
    if (!cfg) return '';
    return cfg.providers.find((p) => p.id === cfg.settings.provider)?.label ?? cfg.settings.provider;
  });

  /**
   * True when the selected provider has no key. Surfaced before upload — the
   * previous behaviour only revealed it after a failed submit, which wasted the
   * upload and read as "the app is asking for the wrong provider".
   */
  readonly providerKeyMissing = computed(() => {
    const cfg = this.config();
    if (!cfg) return false;
    return !cfg.keys.some((k) => k.provider === cfg.settings.provider && k.connected);
  });

  ngOnInit(): void {
    this.api.getVoiceoverConfig().subscribe({
      next: (c) => this.config.set(c),
      error: () => this.startError.set('Could not load Voiceover Studio settings.'),
    });
  }

  ngOnDestroy(): void {
    this.closeStream();
    if (this.copyTimer) clearTimeout(this.copyTimer);
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const picked = input.files?.[0] ?? null;
    this.startError.set('');

    if (!picked) {
      this.file.set(null);
      return;
    }

    const limitMb = this.config()?.settings.maxVideoUploadMb ?? 500;
    if (picked.size > limitMb * 1024 * 1024) {
      this.file.set(null);
      input.value = '';
      this.startError.set(
        `"${picked.name}" is ${this.mb(picked.size)} MB — the limit is ${limitMb} MB.`,
      );
      return;
    }

    this.file.set(picked);
    // Seed the app name from the filename so the common case needs no typing.
    if (!this.appName.trim()) {
      this.appName = picked.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
    }
  }

  mb(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  // ── Job lifecycle ─────────────────────────────────────────────────────────
  start(): void {
    const video = this.file();
    if (!video || !this.canStart()) return;

    this.resetResult();
    this.phase.set('pending');
    this.phaseMessage.set('Uploading video…');

    this.api
      .startVoiceoverJob(video, {
        appName: this.appName.trim(),
        audience: this.audience.trim(),
        tone: this.tone,
      })
      .subscribe({
        next: (res) => {
          this.jobId.set(res.jobId);
          this.openStream(res.jobId);
        },
        error: (err) => {
          this.phase.set('idle');
          this.startError.set(
            err.error?.error?.message ?? 'Failed to start the job. Check the video and try again.',
          );
        },
      });
  }

  cancel(): void {
    const id = this.jobId();
    if (!id) return;
    this.api.cancelVoiceoverJob(id).subscribe({
      next: () => this.phase.set('cancelled'),
      error: () => { /* the job had already finished */ },
    });
  }

  private resetResult(): void {
    this.closeStream();
    this.segments.set([]);
    this.logs.set([]);
    this.meta.set(null);
    this.error.set('');
    this.startError.set('');
    this.jobId.set('');
  }

  private openStream(jobId: string): void {
    const token = this.auth.accessToken() ?? '';
    const es = new EventSource(this.api.voiceoverStreamUrl(jobId, token));
    this.source = es;

    es.onmessage = (msg: MessageEvent<string>) => {
      try {
        this.handleEvent(JSON.parse(msg.data) as VoiceoverEvent);
      } catch {
        /* ignore malformed frames / heartbeats */
      }
    };

    es.onerror = () => {
      // The server closes the stream when the job finishes — only recover if we
      // never reached a terminal phase.
      if (this.running()) this.recoverViaSnapshot(jobId);
      this.closeStream();
    };
  }

  private handleEvent(event: VoiceoverEvent): void {
    switch (event.type) {
      case 'phase':
        if (event.phase !== 'pending') this.phase.set(event.phase);
        this.phaseMessage.set(event.message);
        break;
      case 'log':
        this.logs.update((l) => [...l.slice(-80), { level: event.level, message: event.message }]);
        break;
      case 'meta':
        this.meta.set(event.meta);
        break;
      case 'frames':
        this.phaseMessage.set(
          `${event.count} frames sampled (${event.sceneChanges} at screen transitions)`,
        );
        break;
      case 'segment':
        this.segments.update((s) => [...s, event.segment]);
        break;
      case 'done':
        this.phase.set('done');
        this.phaseMessage.set(
          `${event.totalSegments} segments, ${event.totalWords} words — about ${Math.round(event.spokenSec)}s spoken`,
        );
        break;
      case 'error':
        this.phase.set('error');
        this.error.set(event.message);
        break;
    }
  }

  /** The stream dropped mid-run — pull the authoritative state instead. */
  private recoverViaSnapshot(jobId: string): void {
    this.api.getVoiceoverJob(jobId).subscribe({
      next: (snap) => {
        this.phase.set(snap.phase);
        this.meta.set(snap.meta);
        this.segments.set(snap.segments);
        if (snap.error) this.error.set(snap.error);
      },
      error: () => {
        this.phase.set('error');
        this.error.set('Lost contact with the job and could not recover its state.');
      },
    });
  }

  private closeStream(): void {
    this.source?.close();
    this.source = null;
  }

  // ── Results ───────────────────────────────────────────────────────────────
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
      /* clipboard blocked — the text is selectable in the table */
    }
  }

  download(): void {
    const id = this.jobId();
    if (!id) return;
    window.open(this.api.voiceoverExportUrl(id, this.auth.accessToken() ?? ''), '_blank');
  }
}
