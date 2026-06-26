import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { WidgetConfig } from '../../../../core/models/admin';
import { environment } from '../../../../../environments/environment';

type Launcher = WidgetConfig['launcher'];
type IconKey = WidgetConfig['icon'];
type Animation = WidgetConfig['animation'];
type ThemePref = WidgetConfig['theme'];

/**
 * Connect Settings — edit & persist the embeddable Help widget's defaults, with
 * live controls for launcher style, icon, open animation, theme, side & colour.
 * Saving updates the served /widget.js and the demo page.
 */
@Component({
  selector: 'ha-connect-settings',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTooltipModule,
  ],
  templateUrl: './connect-settings.html',
  styleUrl: './connect-settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectSettings implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);

  // ── Configurable options ──────────────────────────────────────────────────
  readonly position = signal<'right' | 'left'>('right');
  readonly color = signal('#2e6f6a');
  readonly launcher = signal<Launcher>('fab');
  readonly icon = signal<IconKey>('question');
  readonly animation = signal<Animation>('slide');
  readonly theme = signal<ThemePref>('auto');
  readonly label = signal('Need some help?');

  readonly loading = signal(true);
  readonly saving = signal(false);
  private saved = signal('');

  readonly launcherOptions: ReadonlyArray<{ key: Launcher; label: string; icon: string }> = [
    { key: 'fab', label: 'Round button', icon: 'radio_button_checked' },
    { key: 'tab', label: 'Side tab', icon: 'view_sidebar' },
    { key: 'pill', label: 'Pill + text', icon: 'smart_button' },
  ];
  readonly iconOptions: ReadonlyArray<{ key: IconKey; mat: string; label: string }> = [
    { key: 'question', mat: 'help', label: 'Question' },
    { key: 'chat', mat: 'chat_bubble', label: 'Chat' },
    { key: 'book', mat: 'menu_book', label: 'Manual' },
    { key: 'bulb', mat: 'lightbulb', label: 'Tips' },
    { key: 'info', mat: 'info', label: 'Info' },
    { key: 'none', mat: 'block', label: 'None' },
  ];
  readonly animationOptions: ReadonlyArray<{ key: Animation; label: string }> = [
    { key: 'slide', label: 'Slide up' },
    { key: 'slide-side', label: 'Slide in' },
    { key: 'scale', label: 'Pop' },
    { key: 'fade', label: 'Fade' },
    { key: 'none', label: 'Instant' },
  ];
  readonly themeOptions: ReadonlyArray<{ key: ThemePref; label: string; icon: string }> = [
    { key: 'auto', label: 'Auto', icon: 'brightness_auto' },
    { key: 'light', label: 'Light', icon: 'light_mode' },
    { key: 'dark', label: 'Dark', icon: 'dark_mode' },
  ];

  readonly showLabel = computed(() => this.launcher() !== 'fab');
  readonly iconMat = computed(
    () => this.iconOptions.find((o) => o.key === this.icon())?.mat ?? 'help',
  );

  /** Snapshot of the current form, used to detect unsaved changes. */
  private readonly current = computed<WidgetConfig>(() => ({
    launcher: this.launcher(),
    icon: this.icon(),
    label: this.label().trim() || 'Need some help?',
    animation: this.animation(),
    position: this.position(),
    color: this.color(),
    theme: this.theme(),
  }));
  readonly dirty = computed(() => JSON.stringify(this.current()) !== this.saved());

  /** Black/white text colour for best contrast on the chosen accent. */
  readonly onColor = computed(() => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(this.color());
    if (!m) return '#fff';
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const ch = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    const lin = (x: number) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
    const lum = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
    return lum > 0.5 ? '#1a202c' : '#fff';
  });

  // The loader is served by the backend. In production apiBaseUrl is the
  // same-origin '/api', so fall back to the current origin to keep the snippet
  // (and demo link) absolute — external host sites need an absolute src.
  private readonly frontendOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  private readonly backendOrigin =
    environment.apiBaseUrl.replace(/\/api\/?$/, '') || this.frontendOrigin;
  readonly scriptSrc = `${this.backendOrigin}/widget.js`;
  readonly demoUrl = `${this.backendOrigin}/embed-demo`;

  /** Only non-default options are emitted, keeping the snippet clean. */
  readonly snippet = computed(() => {
    const a: string[] = [`data-base="${this.frontendOrigin}"`];
    if (this.position() !== 'right') a.push(`data-position="${this.position()}"`);
    a.push(`data-color="${this.color()}"`);
    if (this.launcher() !== 'fab') a.push(`data-launcher="${this.launcher()}"`);
    if (this.icon() !== 'question') a.push(`data-icon="${this.icon()}"`);
    if (this.animation() !== 'slide') a.push(`data-animation="${this.animation()}"`);
    if (this.theme() !== 'auto') a.push(`data-theme="${this.theme()}"`);
    if (this.showLabel() && this.label().trim()) a.push(`data-label="${this.label().trim()}"`);
    return `<script src="${this.scriptSrc}"\n        ${a.join('\n        ')}></script>`;
  });

  ngOnInit(): void {
    this.api.getWidgetConfig().subscribe({
      next: ({ config }) => {
        this.apply(config);
        this.saved.set(JSON.stringify(this.current()));
        this.loading.set(false);
      },
      error: () => {
        this.saved.set(JSON.stringify(this.current()));
        this.loading.set(false);
      },
    });
  }

  private apply(c: WidgetConfig): void {
    this.launcher.set(c.launcher);
    this.icon.set(c.icon);
    this.label.set(c.label);
    this.animation.set(c.animation);
    this.position.set(c.position);
    this.color.set(c.color);
    this.theme.set(c.theme);
  }

  setLauncher(l: Launcher): void { this.launcher.set(l); }
  setIcon(i: IconKey): void { this.icon.set(i); }
  setAnimation(a: Animation): void { this.animation.set(a); }
  setTheme(t: ThemePref): void { this.theme.set(t); }

  save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.api.saveWidgetConfig(this.current()).subscribe({
      next: ({ config }) => {
        this.apply(config);
        this.saved.set(JSON.stringify(this.current()));
        this.saving.set(false);
        this.snack.open('Widget settings saved — live on /widget.js & the demo', undefined, { duration: 2400 });
      },
      error: () => {
        this.saving.set(false);
        this.snack.open('Could not save settings. Please try again.', undefined, { duration: 3000 });
      },
    });
  }

  copy(): void {
    void navigator.clipboard.writeText(this.snippet());
    this.snack.open('Snippet copied to clipboard', undefined, { duration: 1800 });
  }
}
