import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HelpApiService } from '../../../core/services/help-api';
import { ThemeService } from '../../../core/services/theme.service';
import { ImageViewer } from '../../../core/components/image-viewer/image-viewer';
import { renderStepMarkdown } from '../../../core/utils/step-markdown';
import type { Page } from '../../../core/models/page';

/**
 * Chrome-less help panel rendered inside the embeddable widget's iframe.
 * The host page's route arrives via the `?r=` query param and, on SPA
 * navigation, via postMessage from the loader — we fetch the matching manual.
 */
@Component({
  selector: 'ha-embed-panel',
  imports: [ImageViewer],
  templateUrl: './embed-panel.html',
  styleUrl: './embed-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmbedPanel implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(HelpApiService);
  private readonly theme = inject(ThemeService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly state = signal<'loading' | 'loaded' | 'empty' | 'error'>('loading');
  readonly page = signal<Page | null>(null);
  readonly stepIndex = signal(0);
  readonly viewerSrc = signal<string | null>(null);

  readonly steps = computed(() => this.page()?.steps ?? []);
  readonly total = computed(() => this.steps().length);
  readonly currentStep = computed(() => this.steps()[this.stepIndex()] ?? null);
  readonly bodyHtml = computed(() => {
    const s = this.currentStep();
    return s ? renderStepMarkdown(s.instructionsMd, s.title) : '';
  });
  readonly progress = computed(() => (this.total() ? ((this.stepIndex() + 1) / this.total()) * 100 : 0));

  private readonly onMsg = (e: MessageEvent): void => {
    const d = e.data as { ha?: boolean; type?: string; path?: string; mode?: string } | null;
    if (!d || !d.ha) return;
    if (d.type === 'route' && typeof d.path === 'string') this.loadRoute(d.path);
    if (d.type === 'theme' && typeof d.mode === 'string') this.applyTheme(d.mode);
  };

  ngOnInit(): void {
    window.addEventListener('message', this.onMsg);
    const qp = this.route.snapshot.queryParamMap;
    // Accent + light/dark are configurable by the host via the loader
    // (?c=<color>, ?t=<theme>); both can also change live via postMessage.
    this.applyAccent(qp.get('c'));
    this.applyTheme(qp.get('t'));
    this.loadRoute(qp.get('r') ?? '/');
    try { window.parent.postMessage({ ha: true, type: 'ready' }, '*'); } catch { /* not framed */ }
  }

  /** Apply the host-configured accent colour, picking a legible text colour. */
  private applyAccent(raw: string | null): void {
    const color = this.sanitizeColor(raw);
    if (!color) return;
    const el = this.host.nativeElement;
    el.style.setProperty('--ha-accent', color);
    const on = this.onAccent(color);
    if (on) el.style.setProperty('--ha-on-accent', on);
  }

  /** Follow the host page's light/dark mode (keeping the configured accent). */
  private applyTheme(mode: string | null): void {
    if (mode === 'light' || mode === 'dark') this.theme.mode.set(mode);
    else if (mode === 'auto' || mode === 'system') this.theme.mode.set('system');
  }

  /** Only allow safe CSS colour values (hex / rgb / hsl) — never url()/expressions. */
  private sanitizeColor(raw: string | null): string | null {
    if (!raw) return null;
    const v = raw.trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return v;
    if (/^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\)$/.test(v)) return v;
    return null;
  }

  /** Black or white text for best contrast on the given hex accent. */
  private onAccent(color: string): string | null {
    const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const ch = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    const lin = (x: number) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
    const lum = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
    return lum > 0.5 ? '#1a202c' : '#ffffff';
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onMsg);
  }

  private loadRoute(path: string): void {
    const routePath = path.split('?')[0] || '/';
    this.state.set('loading');
    this.stepIndex.set(0);
    this.page.set(null);
    this.api.getPageByRoute(routePath).subscribe({
      next: (res) => {
        this.page.set(res.page);
        this.state.set((res.page?.steps?.length ?? 0) > 0 ? 'loaded' : 'empty');
      },
      error: (err) => this.state.set(err?.status === 404 ? 'empty' : 'error'),
    });
  }

  prev(): void { this.stepIndex.update((i) => Math.max(0, i - 1)); }
  next(): void { this.stepIndex.update((i) => Math.min(this.total() - 1, i + 1)); }
  close(): void { try { window.parent.postMessage({ ha: true, type: 'close' }, '*'); } catch { /* noop */ } }
}
