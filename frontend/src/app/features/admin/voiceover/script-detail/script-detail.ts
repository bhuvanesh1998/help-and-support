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
import { downloadFile, safeFilename } from '../../../../core/utils/download-file';
import { ConfirmService } from '../../../../core/services/confirm.service';
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
  private readonly confirm = inject(ConfirmService);
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
  readonly savingTrack = signal(false);
  readonly editError = signal('');
  voiceId = '';
  ttsModelId = '';
  /** The account's default TTS model, used when the script has not pinned one. */
  private defaultTtsModel = '';

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

  /**
   * Clip per segment index — but only the take that speaks the line's *current*
   * wording. Older takes stay in the store and are reachable from the line's
   * history; showing one here would play words the script no longer says.
   */
  readonly audioByIndex = computed(() => {
    const currentVersion = new Map(
      (this.script()?.segments ?? []).map((seg) => [seg.index, seg.version ?? 1]),
    );
    const map = new Map<number, VoAudioClip>();
    for (const clip of this.audio()) {
      if (clip.kind === 'timeline') continue;
      if (clip.segmentVersion !== (currentVersion.get(clip.segmentIndex) ?? 1)) continue;
      map.set(clip.segmentIndex, clip);
    }
    return map;
  });

  /** Voice used by the existing clips, so the panel reports what was rendered. */
  readonly renderedVoice = computed(() => this.audio()[0]?.voiceName ?? '');

  /** Takes matching the current script — what the counters and mix are about. */
  readonly lineClips = computed(() => [...this.audioByIndex().values()]);

  /** Takes of wordings that have since been rewritten. Kept, not counted. */
  readonly supersededCount = computed(() => {
    const current = this.audioByIndex();
    return this.audio().filter(
      (c) => c.kind !== 'timeline' && current.get(c.segmentIndex) !== c,
    ).length;
  });

  /** The newest full-length track, once assembled. */
  readonly timelineClip = computed(
    () =>
      this.audio()
        .filter((c) => c.kind === 'timeline')
        .sort((a, b) => b.segmentVersion - a.segmentVersion)[0] ?? null,
  );

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
    // Sample audio is held as a blob URL; without this it leaks for the tab's
    // lifetime every time a voice is auditioned.
    const url = this.sampleUrl();
    if (url) URL.revokeObjectURL(url);
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
        // Whichever of the two loads finishes second settles the voice.
        this.applyScriptVoice();
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
        this.defaultTtsModel = res.models.includes(res.defaultModel)
          ? res.defaultModel
          : (res.models[0] ?? res.defaultModel);
        this.applyScriptVoice();
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

  /**
   * Select the voice this script is actually narrated in.
   *
   * Previously the dropdown defaulted to the first voice the account happened to
   * return, so a re-record could silently land in a different voice from every
   * other line. The script's pinned voice wins; the account default is only a
   * fallback for a script with nothing recorded yet.
   *
   * Called from both the voice list and the script load, since either may finish
   * first.
   */
  private applyScriptVoice(): void {
    const s = this.script();
    const voices = this.voices();
    if (voices.length === 0) return;

    const pinned = s?.voiceId ?? '';
    const available = pinned && voices.some((v) => v.voiceId === pinned);

    this.voiceId = available ? pinned : (voices[0]?.voiceId ?? '');
    this.ttsModelId = s?.ttsModelId || this.defaultTtsModel;

    // A pinned voice missing from the account is worth saying out loud: every
    // re-record from here would quietly change how the script sounds.
    if (pinned && !available) {
      this.ttsError.set(
        `The voice this script was recorded in (${s?.voiceName ?? pinned}) is no longer in your ElevenLabs account. Pick a replacement — existing lines keep their audio until re-recorded.`,
      );
    }
  }

  /** Voice actually used for a render: the panel's choice, else the script's. */
  private effectiveVoice(): { voiceId: string; voiceName: string; modelId: string } | null {
    const s = this.script();
    const chosen = this.voiceId || s?.voiceId || '';
    if (!chosen) return null;

    const known = this.voices().find((v) => v.voiceId === chosen);
    return {
      voiceId: chosen,
      voiceName: known?.name ?? s?.voiceName ?? chosen,
      modelId: this.ttsModelId || s?.ttsModelId || this.defaultTtsModel,
    };
  }

  /** The voice the script is pinned to, for display. */
  readonly scriptVoiceName = computed(() => this.script()?.voiceName ?? '');

  /**
   * Current takes recorded in some other voice than the script's — the symptom
   * of the old defaulting bug, and worth offering to fix in one click.
   */
  readonly offVoiceLines = computed(() => {
    const pinned = this.script()?.voiceId;
    if (!pinned) return [];
    return [...this.audioByIndex().entries()]
      .filter(([, clip]) => clip.voiceId !== pinned)
      .map(([index]) => index)
      .sort((a, b) => a - b);
  });

  /** Newest stitched track; earlier builds are kept as history. */
  readonly timelineBuilds = computed(() =>
    this.audio()
      .filter((c) => c.kind === 'timeline')
      .sort((a, b) => b.segmentVersion - a.segmentVersion),
  );

  readonly previousMixes = computed(() => this.timelineBuilds().slice(1));

  /**
   * Which takes the current script would mix from. Mirrors the server's
   * `timelineSignature` — keep both in step.
   */
  private currentSignature(): string {
    return (this.script()?.segments ?? [])
      .map((seg) => `${seg.index}:${seg.version ?? 1}`)
      .join(',');
  }

  /**
   * True when the track was mixed from wordings that have since changed. The
   * track is kept and still playable — it is the deliverable — but it must not
   * look current when it no longer matches the script.
   */
  readonly trackStale = computed(() => {
    const track = this.timelineClip();
    if (!track) return false;
    // Tracks built before signatures existed cannot be judged; treat them as
    // current rather than nagging about something unknowable.
    if (!track.sourceSignature) return false;
    return track.sourceSignature !== this.currentSignature();
  });

  /** Lines with no take for their current wording — silent in a fresh mix. */
  readonly unrecordedLines = computed(() => {
    const recorded = this.audioByIndex();
    return (this.script()?.segments ?? [])
      .filter((seg) => seg.script.trim() && !recorded.has(seg.index))
      .map((seg) => seg.index);
  });

  clipFor(index: number): VoAudioClip | undefined {
    return this.audioByIndex().get(index);
  }

  /** Render a single line — used for one-off re-takes. */
  renderOne(index: number): void {
    const s = this.script();
    if (!s) return;

    const voice = this.effectiveVoice();
    if (!voice) {
      // Nothing recorded yet and no voice chosen: open the panel rather than
      // failing silently, which is what the old early-return did.
      this.voicePanelOpen.set(true);
      this.ttsError.set('Choose a voice first, then record.');
      return;
    }

    this.renderingIndex.set(index);
    this.ttsError.set('');

    this.api.renderSegmentAudio(s.id, index, voice)
      .subscribe({
        next: (res) => {
          // Replace only the take for this wording: other lines and earlier
          // versions of this one are left alone.
          this.audio.update((list) =>
            [
              ...list.filter(
                (c) =>
                  c.segmentIndex !== index || c.segmentVersion !== res.clip.segmentVersion,
              ),
              res.clip,
            ].sort((a, b) => a.segmentIndex - b.segmentIndex),
          );
          this.renderingIndex.set(null);
          this.refreshSegments();
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
    if (!s) return;

    const voice = this.effectiveVoice();
    if (!voice) {
      this.voicePanelOpen.set(true);
      this.ttsError.set('Choose a voice first, then record.');
      return;
    }

    this.renderingAll.set(true);
    this.ttsError.set('');

    for (const segment of s.segments) {
      if (!segment.script.trim()) continue;
      if (this.audioByIndex().has(segment.index)) continue;

      this.renderingIndex.set(segment.index);
      try {
        const res = await firstValueFrom(
          this.api.renderSegmentAudio(s.id, segment.index, voice),
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

    this.refreshSegments();

    this.renderingIndex.set(null);
    this.renderingAll.set(false);
  }

  /** Clear every clip so a different voice can be used from scratch. */
  async clearAudio(): Promise<void> {
    const s = this.script();
    if (!s) return;

    // Not trash-backed: clips are regenerable, and holding megabytes of audio
    // for 30 days to protect a one-click re-render is not worth the disk. So the
    // dialog says plainly that it is permanent.
    const takes = this.lineClips().length;
    const ok = await this.confirm.ask({
      title: 'Clear all narration audio?',
      message: `${takes} take(s) and the full-length track will be deleted, including earlier versions and mixes. The script and its text are untouched.`,
      note: 'This is not moved to Trash — audio can be re-recorded from the script.',
      confirmLabel: 'Clear audio',
      destructive: true,
    });
    if (!ok) return;

    this.api.deleteScriptAudio(s.id).subscribe({
      next: () => this.audio.set([]),
      error: (err) => this.ttsError.set(err.error?.error?.message ?? 'Could not clear audio.'),
    });
  }

  /**
   * Save a stitched track to disk under a name that says what it is.
   *
   * Goes through a blob rather than a plain link: the file is served from the API
   * origin, and `download` on a cross-origin anchor is ignored — the browser
   * navigated to the MP3 and played it in the tab instead of saving it.
   */
  async saveTrack(clip: VoAudioClip): Promise<void> {
    const s = this.script();
    if (!s) return;

    this.savingTrack.set(true);
    this.ttsError.set('');
    try {
      const name = `${safeFilename(s.videoName)}-${s.tone}-track-build-${clip.segmentVersion}.mp3`;
      await downloadFile(clip.publicUrl, name);
    } catch (err) {
      this.ttsError.set((err as Error).message || 'Could not download that track.');
    } finally {
      this.savingTrack.set(false);
    }
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
        // The take from the previous wording is kept — it is filed under that
        // version and reachable from the line's history. Only the stitched
        // track goes, since it is a mix of words the script no longer says.
        this.audio.update((list) => list.filter((c) => c.kind !== 'timeline'));
      },
      error: (err) =>
        this.editError.set(err.error?.error?.message ?? 'Could not save that line.'),
    });
  }

  /**
   * Put an earlier wording back. Its take, if one was recorded, becomes current
   * again — so undoing an edit normally costs nothing.
   */
  restoreVersion(event: { index: number; version: number }): void {
    const s = this.script();
    if (!s) return;

    this.editError.set('');
    this.api.restoreSegmentVersion(s.id, event.index, event.version).subscribe({
      next: (res) => {
        this.script.update((current) =>
          current
            ? {
                ...current,
                segments: current.segments.map((seg) =>
                  seg.index === event.index ? res.segment : seg,
                ),
                totalWords: current.segments.reduce(
                  (sum, seg) =>
                    sum + (seg.index === event.index ? res.segment.wordCount : seg.wordCount),
                  0,
                ),
              }
            : current,
        );
        // The stitched track was mixed from the wording just replaced.
        this.audio.update((list) => list.filter((c) => c.kind !== 'timeline'));
      },
      error: (err) =>
        this.editError.set(err.error?.error?.message ?? 'Could not restore that version.'),
    });
  }

  /**
   * Re-record the lines that ended up in a different voice, one at a time.
   *
   * Sequential for the same reason as renderAll: ElevenLabs rate-limits
   * concurrent requests, and a serial loop stops at the failure with everything
   * before it saved.
   */
  async reRecordOffVoice(): Promise<void> {
    const s = this.script();
    const voice = this.effectiveVoice();
    const lines = this.offVoiceLines();
    if (!s || !voice || lines.length === 0) return;

    this.renderingAll.set(true);
    this.ttsError.set('');

    for (const index of lines) {
      this.renderingIndex.set(index);
      try {
        const res = await firstValueFrom(this.api.renderSegmentAudio(s.id, index, voice));
        this.audio.update((list) =>
          [
            ...list.filter(
              (c) => c.segmentIndex !== index || c.segmentVersion !== res.clip.segmentVersion,
            ),
            res.clip,
          ].sort((a, b) => a.segmentIndex - b.segmentIndex),
        );
      } catch (err) {
        const message =
          (err as { error?: { error?: { message?: string } } })?.error?.error?.message ??
          'Audio generation failed.';
        this.ttsError.set(`Stopped at line ${index}: ${message}`);
        break;
      }
    }

    this.renderingIndex.set(null);
    this.renderingAll.set(false);
    this.refreshSegments();
  }

  /**
   * Re-read the script so a newly recorded take shows up in the line's history.
   * Cheap, and it keeps the history honest without duplicating the join here.
   */
  private refreshSegments(): void {
    const s = this.script();
    if (!s) return;
    this.api.getVoiceoverScript(s.id).subscribe({
      next: (res) => this.script.set(res.script),
      error: () => {
        /* the page is still usable; history refreshes on the next load */
      },
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
      // A track with silent gaps looks finished until someone watches it.
      this.ttsError.set(
        res.missing > 0
          ? `Track assembled from ${res.lines} line(s). ${res.missing} line(s) have no take for their current wording and are silent — record them and assemble again.`
          : '',
      );
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
