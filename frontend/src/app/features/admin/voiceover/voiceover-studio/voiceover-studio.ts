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
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import { ScriptTable } from '../script-table/script-table';
import type {
  VideoMeta,
  VoiceoverConfig,
  VoiceoverEvent,
  VoJobPhase,
  VoSegment,
  VoTone,
} from '../../../../core/models/admin';

/** Key under which the active job id is parked so a reload can reattach. */
const ACTIVE_JOB_KEY = 'ha.voiceover.activeJob';

interface ToneOption {
  value: VoTone;
  label: string;
  hint: string;
}

/**
 * Generate a voiceover — upload a walkthrough video and watch the run.
 *
 * Output is stored as it is produced, so the finished script lives in the
 * library rather than in this page's state; on completion the user is taken to
 * the saved script.
 */
@Component({
  selector: 'ha-voiceover-studio',
  imports: [
    FormsModule,
    RouterLink,
    ScriptTable,
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
  private readonly router = inject(Router);

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

  /** Durable record for this run — the library and export both key off it. */
  readonly scriptId = signal('');

  private source: EventSource | null = null;

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
    this.reattachActiveJob();
  }

  ngOnDestroy(): void {
    this.closeStream();
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
          localStorage.setItem(ACTIVE_JOB_KEY, res.jobId);
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
    this.scriptId.set('');
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
        localStorage.removeItem(ACTIVE_JOB_KEY);
        // Hand off to the stored script: it owns export, tones and permanence.
        if (event.scriptId) {
          this.scriptId.set(event.scriptId);
          void this.router.navigate(['/admin/voiceover', event.scriptId]);
        }
        this.phaseMessage.set(
          `${event.totalSegments} segments, ${event.totalWords} words — about ${Math.round(event.spokenSec)}s spoken`,
        );
        break;
      case 'error':
        this.phase.set('error');
        this.error.set(event.message);
        localStorage.removeItem(ACTIVE_JOB_KEY);
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

  /**
   * Re-subscribe to a job that was still running when the page was left, so
   * navigating away mid-run no longer abandons it silently.
   */
  private reattachActiveJob(): void {
    const parked = localStorage.getItem(ACTIVE_JOB_KEY);
    if (!parked) return;

    this.api.getVoiceoverJob(parked).subscribe({
      next: (snap) => {
        const live =
          snap.phase === 'pending' ||
          snap.phase === 'probing' ||
          snap.phase === 'extracting' ||
          snap.phase === 'scripting';
        if (!live) {
          localStorage.removeItem(ACTIVE_JOB_KEY);
          // Finished while away — the saved script is the durable view of it.
          if (snap.scriptId) void this.router.navigate(['/admin/voiceover', snap.scriptId]);
          return;
        }
        this.jobId.set(snap.id);
        if (snap.scriptId) this.scriptId.set(snap.scriptId);
        this.phase.set(snap.phase);
        this.meta.set(snap.meta);
        this.segments.set(snap.segments);
        this.openStream(snap.id);
      },
      // Job expired or the server restarted — nothing to reattach to.
      error: () => localStorage.removeItem(ACTIVE_JOB_KEY),
    });
  }
}
