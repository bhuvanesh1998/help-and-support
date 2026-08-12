import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import type {
  VoEffort,
  VoKeyStatus,
  VoProviderId,
  VoProviderMeta,
  VoiceoverBounds,
  VoiceoverSettings,
} from '../../../../core/models/admin';

/** One editable numeric field, with the copy explaining what it costs. */
interface NumField {
  key: keyof VoiceoverSettings;
  label: string;
  hint: string;
  step: number;
  suffix?: string;
}

/**
 * Voiceover settings — the tunables that used to live only in .env, editable
 * here and persisted, so tuning cost and quality no longer needs a redeploy.
 *
 * Also where each provider's API key is connected. Keys are validated against
 * the provider before being stored, and never read back to the browser.
 *
 * Ranges are enforced server-side as well; the min/max on these inputs mirror
 * the same bounds so a bad value is caught before the round trip.
 */
@Component({
  selector: 'ha-voiceover-settings',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  templateUrl: './voiceover-settings.html',
  styleUrl: './voiceover-settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceoverSettingsPage implements OnInit {
  private readonly api = inject(AdminApiService);

  readonly settings = signal<VoiceoverSettings | null>(null);
  readonly bounds = signal<VoiceoverBounds>({});
  readonly providers = signal<VoProviderMeta[]>([]);
  readonly keys = signal<VoKeyStatus[]>([]);
  readonly efforts = signal<VoEffort[]>([]);
  readonly envDefaults = signal<VoiceoverSettings | null>(null);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly error = signal('');

  /** Per-provider key entry state, keyed by provider id. */
  readonly keyInput: Record<string, string> = {};
  readonly connecting = signal<VoProviderId | null>(null);
  readonly keyError = signal('');
  /** Set when connecting a key also moved the provider selection. */
  readonly autoSwitched = signal(false);

  /** Models fetched live from the provider, so the list can never go stale. */
  readonly liveModels = signal<string[]>([]);
  readonly loadingModels = signal(false);
  readonly modelsError = signal('');

  readonly uploadFields: NumField[] = [
    {
      key: 'maxVideoUploadMb',
      label: 'Max video size',
      hint: 'Rejects larger uploads before any processing. Help-manual images keep their own separate limit.',
      step: 50,
      suffix: 'MB',
    },
    {
      key: 'jobRetentionMinutes',
      label: 'Keep finished jobs for',
      hint: 'How long a completed script stays available to review and export.',
      step: 15,
      suffix: 'min',
    },
  ];

  readonly costFields: NumField[] = [
    {
      key: 'maxFrames',
      label: 'Max frames sampled',
      hint: 'The dominant cost control. Every video is reduced to at most this many stills, however long it runs.',
      step: 4,
    },
    {
      key: 'framesPerBatch',
      label: 'Frames per request',
      hint: 'How many stills go to the model at once. Lower means more requests, smaller payload each.',
      step: 1,
    },
    {
      key: 'frameWidth',
      label: 'Frame width',
      hint: 'Downscale width. 960 is enough to read UI text; higher costs proportionally more per frame.',
      step: 80,
      suffix: 'px',
    },
    {
      key: 'frameQuality',
      label: 'Frame JPEG quality',
      hint: 'ffmpeg scale, 1 best to 31 worst. Affects file size, not token count.',
      step: 1,
    },
    {
      key: 'maxTokens',
      label: 'Max tokens per request',
      hint: 'Output ceiling per script request. Reasoning shares this budget, so leave headroom.',
      step: 1000,
    },
  ];

  readonly detectionFields: NumField[] = [
    {
      key: 'sceneThreshold',
      label: 'Scene-change threshold',
      hint: 'Lower catches more screen transitions, so timecodes land on real cuts. Raise it if you get noise.',
      step: 0.05,
    },
    {
      key: 'minFrameGapSec',
      label: 'Min gap between frames',
      hint: 'Stops near-identical stills being sampled twice in quick succession.',
      step: 0.5,
      suffix: 's',
    },
  ];

  readonly narrationFields: NumField[] = [
    {
      key: 'minSegmentSec',
      label: 'Min segment length',
      hint: 'Shortest narration span. Too short and lines feel clipped.',
      step: 1,
      suffix: 's',
    },
    {
      key: 'maxSegmentSec',
      label: 'Max segment length',
      hint: 'Longest narration span. Shorter segments are easier to re-record one at a time.',
      step: 1,
      suffix: 's',
    },
    {
      key: 'wordsPerMinute',
      label: 'Speaking pace',
      hint: 'Sets every word budget. Match it to the voice you will narrate with.',
      step: 5,
      suffix: 'wpm',
    },
  ];

  /** True when the current form differs from the server's env baseline. */
  readonly isCustomised = computed(() => {
    const current = this.settings();
    const base = this.envDefaults();
    if (!current || !base) return false;
    return (Object.keys(base) as Array<keyof VoiceoverSettings>).some(
      (k) => current[k] !== base[k],
    );
  });

  /** Metadata for the currently selected provider. */
  readonly activeProvider = computed(() => {
    const id = this.settings()?.provider;
    return this.providers().find((p) => p.id === id) ?? null;
  });

  /** Key status for the selected provider — drives the "not connected" warning. */
  readonly activeKey = computed(() => {
    const id = this.settings()?.provider;
    return this.keys().find((k) => k.provider === id) ?? null;
  });

  hasKey(provider: VoProviderId): boolean {
    return this.keys().some((k) => k.provider === provider && k.connected);
  }

  /**
   * Ask the provider what it can run. Keeps the saved model in the list even if
   * the provider no longer reports it, so an unrecognised value is visible
   * rather than silently swapped.
   */
  loadModels(): void {
    const provider = this.settings()?.provider;
    if (!provider) return;

    this.loadingModels.set(true);
    this.modelsError.set('');
    this.api.listProviderModels(provider).subscribe({
      next: (res) => {
        const current = this.settings()?.model;
        const models = [...res.models];
        if (current && !models.includes(current)) models.unshift(current);
        this.liveModels.set(models);
        this.loadingModels.set(false);
      },
      error: (err) => {
        this.loadingModels.set(false);
        this.modelsError.set(err.error?.error?.message ?? 'Could not list models.');
      },
    });
  }

  /** Effort only affects Anthropic today; hide it elsewhere rather than lie. */
  readonly effortApplies = computed(() => this.settings()?.provider === 'anthropic');

  readonly wordsPerTenSeconds = computed(() =>
    Math.round(((this.settings()?.wordsPerMinute ?? 0) * 10) / 60),
  );

  readonly requestsPerJob = computed(() => {
    const s = this.settings();
    if (!s) return 0;
    return Math.ceil(s.maxFrames / Math.max(1, s.framesPerBatch));
  });

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.getVoiceoverConfig().subscribe({
      next: (c) => {
        this.settings.set({ ...c.settings });
        this.bounds.set(c.bounds);
        this.providers.set(c.providers);
        this.keys.set(c.keys);
        this.efforts.set(c.efforts);
        this.envDefaults.set(c.envDefaults);
        this.loading.set(false);
        // A connected provider can list its models immediately; without a key
        // the list is unavailable and the field stays free text.
        if (this.hasKey(c.settings.provider)) this.loadModels();
      },
      error: () => {
        this.error.set('Could not load voiceover settings.');
        this.loading.set(false);
      },
    });
  }

  min(key: keyof VoiceoverSettings): number | null {
    return this.bounds()[key]?.min ?? null;
  }

  max(key: keyof VoiceoverSettings): number | null {
    return this.bounds()[key]?.max ?? null;
  }

  value(key: keyof VoiceoverSettings): number {
    return (this.settings()?.[key] as number) ?? 0;
  }

  /** Write a numeric field back, ignoring input that isn't a number yet. */
  setValue(key: keyof VoiceoverSettings, raw: string): void {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    this.settings.update((s) => (s ? { ...s, [key]: parsed } : s));
    this.saved.set(false);
  }

  /** Switching provider also moves the model to that provider's default. */
  setProvider(provider: VoProviderId): void {
    const meta = this.providers().find((p) => p.id === provider);
    this.settings.update((s) =>
      s ? { ...s, provider, model: meta?.defaultModel ?? s.model } : s,
    );
    // The previous provider's models do not apply to the new one.
    this.liveModels.set([]);
    this.modelsError.set('');
    this.saved.set(false);
    if (this.hasKey(provider)) this.loadModels();
  }

  setModel(model: string): void {
    this.settings.update((s) => (s ? { ...s, model } : s));
    this.saved.set(false);
  }

  setEffort(effort: VoEffort): void {
    this.settings.update((s) => (s ? { ...s, effort } : s));
    this.saved.set(false);
  }

  save(): void {
    const current = this.settings();
    if (!current) return;

    this.saving.set(true);
    this.error.set('');
    this.api.saveVoiceoverSettings(current).subscribe({
      next: (res) => {
        // The server clamps out-of-range values, so take its answer as truth.
        this.settings.set({ ...res.settings });
        this.saving.set(false);
        this.saved.set(true);
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(err.error?.error?.message ?? 'Could not save settings.');
      },
    });
  }

  resetToDefaults(): void {
    this.saving.set(true);
    this.error.set('');
    this.api.resetVoiceoverSettings().subscribe({
      next: (res) => {
        this.settings.set({ ...res.settings });
        this.saving.set(false);
        this.saved.set(true);
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(err.error?.error?.message ?? 'Could not reset settings.');
      },
    });
  }

  // ── Provider keys ─────────────────────────────────────────────────────────
  connectKey(provider: VoProviderId): void {
    const key = (this.keyInput[provider] ?? '').trim();
    if (!key) return;

    this.connecting.set(provider);
    this.keyError.set('');
    this.autoSwitched.set(false);
    this.api.connectVoiceoverKey(provider, key).subscribe({
      next: (res) => {
        this.keys.set(res.keys);
        this.keyInput[provider] = '';
        this.connecting.set(null);

        // Connecting a key for a provider that isn't the selected one, while the
        // selected one has no key, is almost always intent to switch — doing it
        // silently would leave the studio reporting a missing key for a provider
        // the operator never meant to use.
        const selected = this.settings()?.provider;
        if (selected && selected !== provider && !this.hasKey(selected)) {
          this.setProvider(provider);
          this.autoSwitched.set(true);
        } else if (selected === provider) {
          this.loadModels();
        }
      },
      error: (err) => {
        this.connecting.set(null);
        this.keyError.set(err.error?.error?.message ?? 'Could not verify that key.');
      },
    });
  }

  disconnectKey(provider: VoProviderId): void {
    this.connecting.set(provider);
    this.keyError.set('');
    this.api.disconnectVoiceoverKey(provider).subscribe({
      next: (res) => {
        this.keys.set(res.keys);
        this.connecting.set(null);
      },
      error: (err) => {
        this.connecting.set(null);
        this.keyError.set(err.error?.error?.message ?? 'Could not disconnect that key.');
      },
    });
  }
}
