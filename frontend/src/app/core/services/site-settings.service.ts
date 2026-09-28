import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { AppConfigService } from '../config/app-config.service';
import { ThemeService } from './theme.service';
import {
  DEFAULT_SITE_SETTINGS,
  type SearchResult,
  type SiteSettings,
  type SupportConfig,
  type TicketCreated,
  type TicketInput,
  type TrackedTicket,
  type RememberedTicket,
} from '../models/support';

const REMEMBER_KEY = 'ha.myTickets';

/**
 * Public branding + support configuration, fetched once and cached as signals.
 * Also exposes the public search and ticket-submission endpoints.
 */
@Injectable({ providedIn: 'root' })
export class SiteSettingsService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(AppConfigService).apiBaseUrl;
  private readonly theme = inject(ThemeService);
  private readonly doc = inject(DOCUMENT);

  readonly settings = signal<SiteSettings>(DEFAULT_SITE_SETTINGS);
  readonly support = signal<SupportConfig | null>(null);
  readonly supportLoaded = signal(false);
  /** Tickets raised from this browser (newest first), for one-click tracking. */
  readonly myTickets = signal<RememberedTicket[]>(this.readRemembered());

  private settingsRequested = false;
  private supportRequested = false;

  /** Theme mode resolved against the OS preference when set to "system". */
  private readonly prefersDark = signal(this.queryPrefersDark());
  readonly isDark = computed(() => {
    const m = this.theme.mode();
    return m === 'dark' || (m === 'system' && this.prefersDark());
  });

  /** Logo for the current effective mode (falls back to the other variant). */
  readonly logoUrl = computed(() => {
    const s = this.settings();
    return this.isDark() ? s.logoDarkUrl || s.logoLightUrl : s.logoLightUrl || s.logoDarkUrl;
  });

  readonly supportAvailable = computed(() => !!this.support()?.enabled);
  readonly widgetSupportAvailable = computed(() => {
    const c = this.support();
    return !!c?.enabled && !!c.widgetEnabled;
  });

  constructor() {
    // Keep the browser-tab icon in sync with the admin-configured favicon.
    effect(() => this.applyFavicon(this.settings().faviconUrl));
    const win = this.doc.defaultView;
    if (win?.matchMedia) {
      win.matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', (e) => this.prefersDark.set(e.matches));
    }
  }

  loadSettings(): void {
    if (this.settingsRequested) return;
    this.settingsRequested = true;
    this.http.get<{ settings: Partial<SiteSettings> }>(`${this.base}/public/site-settings`).subscribe({
      next: ({ settings }) => this.settings.set(this.merge(settings)),
      error: () => { this.settingsRequested = false; },
    });
  }

  loadSupport(): void {
    if (this.supportRequested) return;
    this.supportRequested = true;
    this.http.get<{ config: SupportConfig }>(`${this.base}/public/support/config`).subscribe({
      next: ({ config }) => { this.support.set(config); this.supportLoaded.set(true); },
      error: () => { this.supportRequested = false; this.supportLoaded.set(true); },
    });
  }

  trackTicket(number: string, email: string): Observable<TrackedTicket> {
    return this.http
      .post<{ ticket: TrackedTicket }>(`${this.base}/public/support/tickets/track`, { number, email })
      .pipe(map((r) => r.ticket));
  }

  followUpTicket(number: string, email: string, message: string): Observable<TrackedTicket> {
    return this.http
      .post<{ ticket: TrackedTicket }>(`${this.base}/public/support/tickets/track/reply`, { number, email, message })
      .pipe(map((r) => r.ticket));
  }

  rememberTicket(t: RememberedTicket): void {
    const list = [t, ...this.myTickets().filter((x) => x.number !== t.number)].slice(0, 10);
    this.myTickets.set(list);
    try { this.doc.defaultView?.localStorage.setItem(REMEMBER_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
  }

  forgetTicket(number: string): void {
    const list = this.myTickets().filter((x) => x.number !== number);
    this.myTickets.set(list);
    try { this.doc.defaultView?.localStorage.setItem(REMEMBER_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
  }

  private readRemembered(): RememberedTicket[] {
    try {
      const raw = this.doc.defaultView?.localStorage.getItem(REMEMBER_KEY);
      const list = raw ? (JSON.parse(raw) as RememberedTicket[]) : [];
      return Array.isArray(list) ? list.filter((t) => t && typeof t.number === 'string' && typeof t.email === 'string') : [];
    } catch {
      return [];
    }
  }

  submitTicket(input: TicketInput): Observable<TicketCreated> {
    return this.http
      .post<{ ticket: TicketCreated }>(`${this.base}/public/support/tickets`, input)
      .pipe(map((r) => r.ticket));
  }

  search(q: string, limit = 8): Observable<SearchResult[]> {
    return this.http
      .get<{ results: SearchResult[] }>(`${this.base}/public/search`, { params: { q, limit } })
      .pipe(map((r) => r.results ?? []));
  }

  private applyFavicon(href: string | null): void {
    const head = this.doc.head;
    if (!head) return;
    for (const rel of ['icon', 'apple-touch-icon']) {
      let link = head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!link) {
        if (!href) continue;
        link = this.doc.createElement('link');
        link.rel = rel;
        head.appendChild(link);
      }
      // Remember the build's default so clearing the setting restores it.
      link.dataset['defaultHref'] ??= link.getAttribute('href') ?? '';
      const next = href || link.dataset['defaultHref'];
      if (next) {
        link.href = next;
        if (href) link.removeAttribute('type'); // let the browser sniff PNG/SVG/ICO
      }
    }
  }

  private merge(s: Partial<SiteSettings> | null | undefined): SiteSettings {
    const d = DEFAULT_SITE_SETTINGS;
    return {
      brandName: s?.brandName?.trim() || d.brandName,
      copyrightText: s?.copyrightText?.trim() || d.copyrightText,
      creditText: s?.creditText?.trim() || d.creditText,
      creditUrl: s?.creditUrl?.trim() || d.creditUrl,
      logoLightUrl: s?.logoLightUrl || null,
      logoDarkUrl: s?.logoDarkUrl || null,
      faviconUrl: s?.faviconUrl || null,
    };
  }

  private queryPrefersDark(): boolean {
    try {
      return !!this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  }
}
