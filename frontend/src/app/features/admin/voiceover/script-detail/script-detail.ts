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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import { ScriptTable } from '../script-table/script-table';
import type {
  TtsVoice,
  VoAudioClip,
  VoiceoverEvent,
  VoScriptDetail,
  VoScriptSummary,
  VoTone,
} from '../../../../core/models/admin';

/**
 * One saved script: its timing table, the export, and re-running the same frames
 * in another tone.
 *
 * Regeneration needs no re-upload — the stills were kept when the video was
 * first processed, which is the whole reason they are stored on disk.
 */
@Component({
  selector: 'ha-script-detail',
  imports: [
    FormsModule,
    RouterLink,
    ScriptTable,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  templateUrl: './script-detail.html',
  styleUrl: './script-detail.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScriptDetail implements OnInit, OnDestroy {
  private readonly api = inject(AdminApiService);
  private readonly auth = inject(AuthStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly script = signal<VoScriptDetail | null>(null);
  readonly variants = signal<VoScriptSummary[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');

  // ── Regeneration ──────────────────────────────────────────────────────────
  readonly regenerating = signal(false);
  readonly regenPhase = signal('');
  readonly regenError = signal('');
  newTone: VoTone = 'marketing';

  readonly toneOptions: Array<{ value: VoTone; label: string }> = [
    { value: 'instructional', label: 'Instructional — teach the steps' },
    { value: 'marketing', label: 'Marketing — lead with the outcome' },
    { value: 'onboarding', label: 'Onboarding — welcome a new user' },
  ];

  // ── Narration audio ───────────────────────────────────────────────────────
  readonly voices = signal<TtsVoice[]>([]);
  readonly ttsModels = signal<string[]>([]);
  readonly audio = signal<VoAudioClip[]>([]);
  readonly ttsAvailable = signal(false);
  readonly ttsError = signal('');
  /** Segment index currently rendering, so the row can show progress. */
  readonly renderingIndex = signal<number | null>(null);
  readonly renderingAll = signal(false);
  /** The voice config panel is opt-in, so the page stays quiet until needed. */
  readonly voicePanelOpen = signal(false);
  readonly sampling = signal(false);
  readonly sampleUrl = signal<string | null>(null);
  readonly building = signal(false);
  readonly editError = signal('');
  voiceId = '';
  ttsModelId = '';

  private source: EventSource | null = null;

  readonly spokenSec = computed(() => {
    const s = this.script();
    if (!s) return 0;
    return Math.round((s.totalWords / (s.wordsPerMinute || 150)) * 60);
  });

  /** Tones that already exist for these frames, so we don't offer duplicates. */
  readonly existingTones = computed(() => {
    const s = this.script();
    const tones = new Set<string>();
    if (s) tones.add(s.tone);
    for (const v of this.variants()) tones.add(v.tone);
    return tones;
  });

  readonly availableTones = computed(() =>
    this.toneOptions.filter((t) => !this.existingTones().has(t.value)),
  );

  /** Clip per segment index, for the table's play buttons. */
  readonly audioByIndex = computed(() => {
    const map = new Map<number, VoAudioClip>();
    for (const clip of this.audio()) map.set(clip.segmentIndex, clip);
    return map;
  });

  /** Voice used by the existing clips, so the panel reports what was rendered. */
  readonly renderedVoice = computed(() => this.audio()[0]?.voiceName ?? '');

  /** Per-line clips only — the stitched track is presented separately. */
  readonly lineClips = computed(() => this.audio().filter((c) => c.kind !== 'timeline'));

  /** The full-length track, once assembled. */
  readonly timelineClip = computed(() => this.audio().find((c) => c.kind === 'timeline') ?? null);

  readonly lineCount = computed(
    () => this.script()?.segments.filter((s) => s.script.trim()).length ?? 0,
  );

  readonly allLinesRendered = computed(
    () => this.lineCount() > 0 && this.lineClips().length >= this.lineCount(),
  );

  ngOnInit(): void {
    // paramMap rather than a snapshot so navigating between variants reloads.
    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      if (id) {
        this.load(id);
        this.loadAudio(id);
      }
    });
    this.loadVoices();
  }

  ngOnDestroy(): void {
    this.closeStream();
  }

  private load(id: string): void {
    this.loading.set(true);
    this.error.set('');
    this.api.getVoiceoverScript(id).subscribe({
      next: (res) => {
        this.script.set(res.script);
        this.loading.set(false);
        const first = this.availableTones()[0];
        if (first) this.newTone = first.value;
        this.loadVariants(res.script);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('That script could not be found. It may have been deleted.');
      },
    });
  }

  /** Sibling tones of the same frames, including the original. */
  private loadVariants(script: VoScriptDetail): void {
    const rootId = script.sourceScriptId ?? script.id;
    this.api.listVoiceoverScripts({ search: script.videoName }).subscribe({
      next: (res) => {
        this.variants.set(
          res.scripts.filter(
            (s) => s.id !== script.id && (s.id === rootId || s.sourceScriptId === rootId),
          ),
        );
        const first = this.availableTones()[0];
        if (first) this.newTone = first.value;
      },
      error: () => { /* variants are a convenience, not load-bearing */ },
    });
  }

  download(): void {
    const s = this.script();
    if (!s) return;
    window.open(this.api.voiceoverExportUrl(s.id, this.auth.accessToken() ?? ''), '_blank');
  }

  // ── Narration audio ───────────────────────────────────────────────────────
  private loadVoices(): void {
    this.api.listTtsVoices().subscribe({
      next: (res) => {
        this.ttsAvailable.set(true);
        this.voices.set(res.voices);
        this.ttsModels.set(res.models);
        this.voiceId = res.voices[0]?.voiceId ?? '';
        this.ttsModelId = res.models.includes(res.defaultModel)
          ? res.defaultModel
          : (res.models[0] ?? res.defaultModel);
      },
      error: (err) => {
        // No key connected is the normal case, not an error worth shouting about.
        this.ttsAvailable.set(false);
        this.ttsError.set(err.error?.error?.message ?? '');
      },
    });
  }

  private loadAudio(scriptId: string): void {
    this.api.listScriptAudio(scriptId).subscribe({
      next: (res) => this.audio.set(res.audio),
      error: () => this.audio.set([]),
    });
  }

  clipFor(index: number): VoAudioClip | undefined {
    return this.audioByIndex().get(index);
  }

  /** Render a single line — used for one-off re-takes. */
  renderOne(index: number): void {
    const s = this.script();
    if (!s || !this.voiceId) return;

    const voice = this.voices().find((v) => v.voiceId === this.voiceId);
    this.renderingIndex.set(index);
    this.ttsError.set('');

    this.api
      .renderSegmentAudio(s.id, index, {
        voiceId: this.voiceId,
        voiceName: voice?.name ?? this.voiceId,
        modelId: this.ttsModelId,
      })
      .subscribe({
        next: (res) => {
          // Replace just this clip so finished takes are never disturbed.
          this.audio.update((list) => [
            ...list.filter((c) => c.segmentIndex !== index),
            res.clip,
          ].sort((a, b) => a.segmentIndex - b.segmentIndex));
          this.renderingIndex.set(null);
        },
        error: (err) => {
          this.renderingIndex.set(null);
          this.ttsError.set(err.error?.error?.message ?? `Segment ${index} failed to render.`);
        },
      });
  }

  /**
   * Render every line that has no clip yet, one request at a time.
   *
   * Sequential rather than parallel: ElevenLabs rate-limits concurrent requests,
   * and a serial loop means a failure stops at that line with everything before
   * it already saved.
   */
  async renderAll(): Promise<void> {
    const s = this.script();
    if (!s || !this.voiceId) return;

    const voice = this.voices().find((v) => v.voiceId === this.voiceId);
    this.renderingAll.set(true);
    this.ttsError.set('');

    for (const segment of s.segments) {
      if (!segment.script.trim()) continue;
      if (this.audioByIndex().has(segment.index)) continue;

      this.renderingIndex.set(segment.index);
      try {
        const res = await firstValueFrom(
          this.api.renderSegmentAudio(s.id, segment.index, {
            voiceId: this.voiceId,
            voiceName: voice?.name ?? this.voiceId,
            modelId: this.ttsModelId,
          }),
        );
        this.audio.update((list) => [...list, res.clip].sort((a, b) => a.segmentIndex - b.segmentIndex));
      } catch (err) {
        const message =
          (err as { error?: { error?: { message?: string } } })?.error?.error?.message ??
          'Audio generation failed.';
        this.ttsError.set(`Stopped at segment ${segment.index}: ${message}`);
        break;
      }
    }

    this.renderingIndex.set(null);
    this.renderingAll.set(false);
  }

  /** Clear every clip so a different voice can be used from scratch. */
  clearAudio(): void {
    const s = this.script();
    if (!s) return;
    this.api.deleteScriptAudio(s.id).subscribe({
      next: () => this.audio.set([]),
      error: (err) => this.ttsError.set(err.error?.error?.message ?? 'Could not clear audio.'),
    });
  }

  downloadAudio(): void {
    const s = this.script();
    if (!s) return;
    window.open(this.api.voiceoverAudioExportUrl(s.id, this.auth.accessToken() ?? ''), '_blank');
  }

  /** Persist a hand-edited line. Its audio is dropped server-side, since the
   *  clip would otherwise say something the script no longer does. */
  saveLine(change: { index: number; script: string }): void {
    const s = this.script();
    if (!s) return;

    this.editError.set('');
    this.api.updateSegmentText(s.id, change.index, change.script).subscribe({
      next: (res) => {
        this.script.update((current) =>
          current
            ? {
                ...current,
                segments: current.segments.map((seg) =>
                  seg.index === change.index ? res.segment : seg,
                ),
                totalWords: current.segments.reduce(
                  (sum, seg) =>
                    sum + (seg.index === change.index ? res.segment.wordCount : seg.wordCount),
                  0,
                ),
              }
            : current,
        );
        // The edit invalidated this line's clip and the stitched track.
        this.audio.update((list) =>
          list.filter((c) => c.segmentIndex !== change.index && c.kind !== 'timeline'),
        );
      },
      error: (err) =>
        this.editError.set(err.error?.error?.message ?? 'Could not save that line.'),
    });
  }

  // ── Voice config ──────────────────────────────────────────────────────────
  toggleVoicePanel(): void {
    this.voicePanelOpen.update((open) => !open);
  }

  /** Play a short sample so the voice is chosen by ear, not by name. */
  async playSample(): Promise<void> {
    if (!this.voiceId) return;
    const first = this.script()?.segments[0]?.script;

    this.sampling.set(true);
    this.ttsError.set('');
    try {
      const blob = await firstValueFrom(
        this.api.sampleVoice({
          voiceId: this.voiceId,
          modelId: this.ttsModelId,
          // Sampling the real first line is more useful than generic filler.
          text: first,
        }),
      );
      // Revoke the previous URL so repeated samples do not leak blobs.
      const previous = this.sampleUrl();
      if (previous) URL.revokeObjectURL(previous);
      this.sampleUrl.set(URL.createObjectURL(blob));
    } catch {
      this.ttsError.set('Could not render a sample with that voice.');
    } finally {
      this.sampling.set(false);
    }
  }

  /**
   * Render every missing line, then stitch one full-length track — the single
   * file that gets dropped under the video.
   */
  async generateAll(): Promise<void> {
    await this.renderAll();
    if (this.ttsError()) return;
    await this.buildTimeline();
  }

  /** Assemble the per-line clips into one track matching the video length. */
  async buildTimeline(): Promise<void> {
    const s = this.script();
    if (!s) return;

    this.building.set(true);
    this.ttsError.set('');
    try {
      const res = await firstValueFrom(this.api.buildAudioTimeline(s.id));
      this.audio.update((list) => [...list.filter((c) => c.kind !== 'timeline'), res.clip]);
    } catch (err) {
      const message =
        (err as { error?: { error?: { message?: string } } })?.error?.error?.message ??
        'Could not assemble the track.';
      this.ttsError.set(message);
    } finally {
      this.building.set(false);
    }
  }

  /** Re-run the stored frames in another tone; result is a new sibling script. */
  regenerate(): void {
    const s = this.script();
    if (!s || !this.newTone) return;

    this.regenerating.set(true);
    this.regenError.set('');
    this.regenPhase.set('Starting…');

    this.api.regenerateVoiceoverScript(s.id, this.newTone).subscribe({
      next: (res) => this.watchRegeneration(res.jobId),
      error: (err) => {
        this.regenerating.set(false);
        this.regenError.set(err.error?.error?.message ?? 'Could not start regeneration.');
      },
    });
  }

  private watchRegeneration(jobId: string): void {
    const token = this.auth.accessToken() ?? '';
    const es = new EventSource(this.api.voiceoverStreamUrl(jobId, token));
    this.source = es;

    es.onmessage = (msg: MessageEvent<string>) => {
      try {
        const event = JSON.parse(msg.data) as VoiceoverEvent;
        switch (event.type) {
          case 'phase':
            this.regenPhase.set(event.message);
            break;
          case 'segment':
            this.regenPhase.set(`Wrote segment ${event.segment.index}…`);
            break;
          case 'done':
            this.regenerating.set(false);
            this.closeStream();
            // Land on the new tone so the result is immediately visible.
            if (event.scriptId) {
              void this.router.navigate(['/admin/voiceover', event.scriptId]);
            }
            break;
          case 'error':
            this.regenerating.set(false);
            this.regenError.set(event.message);
            this.closeStream();
            break;
        }
      } catch {
        /* ignore heartbeats and malformed frames */
      }
    };

    es.onerror = () => {
      if (this.regenerating()) {
        this.regenerating.set(false);
        this.regenError.set('Lost contact with the regeneration job.');
      }
      this.closeStream();
    };
  }

  private closeStream(): void {
    this.source?.close();
    this.source = null;
  }

  timecode(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  when(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }
}
