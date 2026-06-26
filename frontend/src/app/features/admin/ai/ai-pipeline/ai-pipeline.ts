import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import type {
  AiCredentialStatus,
  AiDraftTutorial,
  AiJobPhase,
  AiPipelineEvent,
  AiScreen,
  AiSessionInjection,
} from '../../../../core/models/admin';

type PublishStatus = 'idle' | 'pending' | 'done' | 'error';

interface TutorialState {
  tutorial: AiDraftTutorial;
  selected: boolean;
  status: PublishStatus;
  pageId: string | null;
  error: string | null;
}

interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

@Component({
  selector: 'ha-ai-pipeline',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatSnackBarModule, MatTooltipModule],
  templateUrl: './ai-pipeline.html',
  styleUrl: './ai-pipeline.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AIPipeline implements OnInit, OnDestroy {
  private readonly api   = inject(AdminApiService);
  private readonly auth  = inject(AuthStore);
  private readonly snack = inject(MatSnackBar);

  @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

  // ── Mode ──────────────────────────────────────────────────────────────────
  readonly mode = signal<'capture' | 'import'>('capture');

  // ── Capture form ──────────────────────────────────────────────────────────
  baseUrl      = '';
  appName      = '';
  email        = '';
  password     = '';
  anthropicKey = '';
  model        = 'claude-sonnet-4-6';
  navDepth     = 1;
  headed       = false;
  sessionJson  = '';
  readonly showKey  = signal(false);
  readonly showPass = signal(false);

  readonly models = [
    { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6 — balanced (recommended)' },
    { id: 'claude-opus-4-8',            label: 'Claude Opus 4.8 — highest quality' },
    { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5 — fastest / cheapest' },
  ];

  // ── Stored Claude credential (connect once, reuse every run) ────────────────
  readonly credential       = signal<AiCredentialStatus | null>(null);
  readonly connected        = computed(() => this.credential()?.connected ?? false);
  readonly showConnectPanel = signal(false);
  readonly connecting       = signal(false);
  readonly connectError     = signal('');

  // ── Job state ───────────────────────────────────────────────────────────────
  readonly jobId     = signal<string | null>(null);
  readonly phase     = signal<AiJobPhase | 'idle'>('idle');
  readonly screens   = signal<AiScreen[]>([]);
  readonly logs      = signal<LogLine[]>([]);
  readonly states    = signal<TutorialState[]>([]);
  readonly startError = signal('');
  readonly doneStats = signal<{ screens: number; tutorials: number } | null>(null);

  // ── Import JSON ───────────────────────────────────────────────────────────
  readonly jsonText  = signal('');
  readonly jsonError = signal('');

  private source: EventSource | null = null;

  // ── Derived ───────────────────────────────────────────────────────────────
  readonly running = computed(() => this.phase() === 'scraping' || this.phase() === 'drafting');
  readonly selectedCount  = computed(() => this.states().filter(s => s.selected).length);
  readonly publishedCount = computed(() => this.states().filter(s => s.status === 'done').length);
  readonly showReview = computed(() =>
    this.states().length > 0 &&
    (this.phase() === 'done' || this.mode() === 'import' || this.publishedCount() > 0),
  );

  private readonly mediaByScreenId = computed(() => {
    const map = new Map<string, string | null>();
    for (const s of this.screens()) map.set(s.id, s.mediaId);
    return map;
  });

  ngOnInit(): void { this.loadCredential(); }
  ngOnDestroy(): void { this.closeStream(); }

  // ── Claude connection ───────────────────────────────────────────────────────
  loadCredential(): void {
    this.api.getAiCredential().subscribe({
      next: c => {
        this.credential.set(c);
        if (c.connected && c.model) this.model = c.model;
        this.showConnectPanel.set(!c.connected);
      },
      error: () => { /* leave disconnected */ },
    });
  }

  openConnectPanel(): void {
    this.connectError.set('');
    this.anthropicKey = '';
    this.showConnectPanel.set(true);
  }

  connectClaude(): void {
    this.connectError.set('');
    const key = this.anthropicKey.trim();
    if (!key) { this.connectError.set('Paste your Claude API key'); return; }
    this.connecting.set(true);
    this.api.saveAiCredential({ anthropicKey: key, model: this.model }).subscribe({
      next: c => {
        this.connecting.set(false);
        this.credential.set(c);
        this.anthropicKey = '';
        this.showConnectPanel.set(false);
        this.snack.open('Claude connected', undefined, { duration: 2500 });
      },
      error: err => {
        this.connecting.set(false);
        this.connectError.set(err.error?.error?.message ?? 'Could not validate this key');
      },
    });
  }

  disconnectClaude(): void {
    this.api.deleteAiCredential().subscribe({
      next: () => {
        this.credential.set({ connected: false, keyLast4: null, model: null, validatedAt: null, updatedAt: null });
        this.anthropicKey = '';
        this.showConnectPanel.set(true);
        this.snack.open('Claude disconnected', undefined, { duration: 2000 });
      },
      error: () => this.snack.open('Disconnect failed', 'OK', { duration: 3000 }),
    });
  }

  // ── Phase labels ────────────────────────────────────────────────────────────
  phaseLabel(): string {
    switch (this.phase()) {
      case 'scraping': return 'Mapping screens…';
      case 'drafting': return 'Drafting user manuals with AI…';
      case 'done':     return 'Pipeline complete';
      case 'error':    return 'Pipeline failed';
      case 'cancelled':return 'Cancelled';
      default:         return '';
    }
  }

  // ── Start a live capture job ──────────────────────────────────────────────
  startCapture(): void {
    this.startError.set('');
    if (!this.baseUrl.trim()) { this.startError.set('App URL is required'); return; }
    if (!this.connected()) {
      this.startError.set('Connect your Claude account first');
      this.showConnectPanel.set(true);
      return;
    }

    // Optional pre-authenticated session (skips login + captcha).
    let session: AiSessionInjection | undefined;
    const sj = this.sessionJson.trim();
    if (sj) {
      try {
        session = JSON.parse(sj) as AiSessionInjection;
      } catch {
        this.startError.set('Session must be valid JSON (see the hint below the field).');
        return;
      }
    }

    this.resetJobState();
    this.phase.set('pending');

    // No key sent — the backend uses the stored, connected Claude credential.
    this.api.startAiJob({
      baseUrl:  this.baseUrl.trim(),
      appName:  this.appName.trim(),
      email:    this.email.trim(),
      password: this.password,
      model:    this.model,
      navDepth: Number(this.navDepth),
      headed:   this.headed,
      ...(session ? { session } : {}),
    }).subscribe({
      next: res => {
        this.jobId.set(res.jobId);
        this.openStream(res.jobId);
      },
      error: err => {
        this.phase.set('idle');
        this.startError.set(err.error?.error?.message ?? 'Failed to start the job');
      },
    });
  }

  private openStream(jobId: string): void {
    const token = this.auth.accessToken() ?? '';
    const url = this.api.aiStreamUrl(jobId, token);
    const es = new EventSource(url);
    this.source = es;

    es.onmessage = (msg: MessageEvent<string>) => {
      try {
        const event = JSON.parse(msg.data) as AiPipelineEvent;
        this.handleEvent(event);
      } catch { /* ignore malformed frames / heartbeats */ }
    };

    es.onerror = () => {
      // The server closes the stream when the job finishes — only surface an
      // error if we never reached a terminal phase.
      if (this.running() || this.phase() === 'pending') {
        // Fall back to a snapshot fetch to recover final state.
        this.recoverViaSnapshot(jobId);
      }
      this.closeStream();
    };
  }

  private handleEvent(event: AiPipelineEvent): void {
    switch (event.type) {
      case 'phase':
        if (event.phase !== 'pending') this.phase.set(event.phase);
        break;
      case 'log':
        this.appendLog(event.level, event.message);
        break;
      case 'screen':
        this.screens.update(arr =>
          arr.some(s => s.id === event.screen.id) ? arr : [...arr, event.screen],
        );
        break;
      case 'draft':
        this.addTutorial(event.tutorial);
        break;
      case 'done':
        this.phase.set('done');
        this.doneStats.set({ screens: event.totalScreens, tutorials: event.totalTutorials });
        break;
      case 'error':
        this.phase.set('error');
        this.startError.set(event.message);
        break;
    }
  }

  private recoverViaSnapshot(jobId: string): void {
    this.api.getAiJob(jobId).subscribe({
      next: snap => {
        this.phase.set(snap.phase);
        this.screens.set(snap.screens);
        if (snap.tutorials.length && this.states().length === 0) {
          this.states.set(snap.tutorials.map(t => this.toState(t)));
        }
        if (snap.error) this.startError.set(snap.error);
      },
      error: () => { /* job expired — leave current state */ },
    });
  }

  private addTutorial(tutorial: AiDraftTutorial): void {
    this.states.update(arr =>
      arr.some(s => s.tutorial.groupId === tutorial.groupId)
        ? arr
        : [...arr, this.toState(tutorial)],
    );
  }

  private toState(tutorial: AiDraftTutorial): TutorialState {
    return { tutorial, selected: true, status: 'idle', pageId: null, error: null };
  }

  private appendLog(level: 'info' | 'warn' | 'error', message: string): void {
    this.logs.update(arr => {
      const next = [...arr, { level, message, at: new Date().toISOString() }];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }

  private closeStream(): void {
    if (this.source) { this.source.close(); this.source = null; }
  }

  cancel(): void {
    const id = this.jobId();
    if (!id) return;
    this.api.cancelAiJob(id).subscribe({ error: () => {} });
    this.closeStream();
    this.phase.set('cancelled');
  }

  // ── Import JSON path ────────────────────────────────────────────────────────
  triggerFile(): void { this.fileInputRef.nativeElement.click(); }

  onFile(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { this.jsonText.set(ev.target?.result as string); this.parseJson(); };
    reader.readAsText(file);
    (e.target as HTMLInputElement).value = '';
  }

  parseJson(): void {
    this.jsonError.set('');
    try {
      const parsed = JSON.parse(this.jsonText()) as { tutorials?: AiDraftTutorial[] };
      if (!Array.isArray(parsed.tutorials)) throw new Error('Missing "tutorials" array');
      this.resetJobState();
      this.states.set(parsed.tutorials.map((t, i) => this.toState({
        groupId:   t.groupId ?? `import-${i}`,
        groupName: t.groupName ?? t.page?.title ?? `User Manual ${i + 1}`,
        page:      t.page,
        steps:     (t.steps ?? []).map((s, j) => ({
          stepNumber:   s.stepNumber ?? j + 1,
          title:        s.title,
          instructionsMd: s.instructionsMd,
          screenshotId: s.screenshotId ?? '',
          imageUrl:     s.imageUrl ?? null,
        })),
      })));
      this.phase.set('done');
    } catch (err) {
      this.jsonError.set(err instanceof Error ? err.message : 'Invalid JSON');
    }
  }

  // ── Review & publish ──────────────────────────────────────────────────────
  toggleAll(checked: boolean): void {
    this.states.update(s => s.map(t => t.status === 'idle' ? { ...t, selected: checked } : t));
  }

  toggleOne(index: number): void {
    this.states.update(s => s.map((t, i) => i === index ? { ...t, selected: !t.selected } : t));
  }

  async publishSelected(): Promise<void> {
    const toPublish = this.states()
      .map((s, i) => ({ s, i }))
      .filter(x => x.s.selected && x.s.status === 'idle');

    const mediaMap = this.mediaByScreenId();

    for (const { s, i } of toPublish) {
      this.patchState(i, { status: 'pending' });
      try {
        const pageRes = await firstValueFrom(this.api.createPage({
          routePath:   s.tutorial.page.routePath,
          title:       s.tutorial.page.title,
          description: s.tutorial.page.description,
        }));
        const pageId = pageRes.page.id;

        for (const step of s.tutorial.steps) {
          const mediaId = mediaMap.get(step.screenshotId) ?? undefined;
          await firstValueFrom(this.api.createStep(pageId, {
            stepNumber:     step.stepNumber,
            title:          step.title,
            instructionsMd: step.instructionsMd,
            ...(step.imageUrl ? { imageUrl: step.imageUrl } : {}),
            ...(mediaId ? { mediaAssetId: mediaId } : {}),
          }));
        }
        this.patchState(i, { status: 'done', pageId });
      } catch (err: unknown) {
        const msg = (err as { error?: { error?: { message?: string } } })?.error?.error?.message ?? 'Publish failed';
        this.patchState(i, { status: 'error', error: msg });
      }
    }

    this.snack.open(`Published ${this.publishedCount()} user manual(s)`, undefined, { duration: 3000 });
  }

  private patchState(index: number, patch: Partial<TutorialState>): void {
    this.states.update(arr => arr.map((t, i) => i === index ? { ...t, ...patch } : t));
  }

  // ── Reset ───────────────────────────────────────────────────────────────────
  private resetJobState(): void {
    this.closeStream();
    this.jobId.set(null);
    this.screens.set([]);
    this.logs.set([]);
    this.states.set([]);
    this.doneStats.set(null);
    this.startError.set('');
  }

  reset(): void {
    this.resetJobState();
    this.jsonText.set('');
    this.jsonError.set('');
    this.phase.set('idle');
  }
}
