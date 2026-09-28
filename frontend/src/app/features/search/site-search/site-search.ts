import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged, of, switchMap, catchError, tap } from 'rxjs';
import { SiteSettingsService } from '../../../core/services/site-settings.service';
import type { SearchResult } from '../../../core/models/support';
import { highlightParts, type HighlightPart } from '../highlight';

/**
 * Keyword search for the landing top bar. Debounced live suggestions with
 * full keyboard support; submitting falls through to the crawlable /search page.
 * On narrow screens it collapses to an icon that opens a full-width overlay.
 */
@Component({
  selector: 'ha-site-search',
  templateUrl: './site-search.html',
  styleUrl: './site-search.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.overlay-open]': 'overlayOpen()',
    '(document:keydown.escape)': 'closeAll()',
  },
})
export class SiteSearch {
  private readonly site = inject(SiteSettingsService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('q');

  readonly query = signal('');
  readonly results = signal<SearchResult[]>([]);
  readonly loading = signal(false);
  readonly open = signal(false);
  readonly active = signal(-1);
  readonly overlayOpen = signal(false);
  readonly searched = signal(false);

  readonly showDropdown = computed(
    () => this.open() && this.query().trim().length >= 2 && (this.searched() || this.loading()),
  );

  private readonly q$ = new Subject<string>();

  constructor() {
    this.q$
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        tap((q) => {
          this.active.set(-1);
          if (q.length < 2) {
            this.results.set([]);
            this.searched.set(false);
          }
        }),
        switchMap((q) => {
          if (q.length < 2) return of<SearchResult[] | null>(null);
          this.loading.set(true);
          return this.site.search(q, 8).pipe(catchError(() => of<SearchResult[]>([])));
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((r) => {
        this.loading.set(false);
        if (r === null) return;
        this.results.set(r);
        this.searched.set(true);
      });
  }

  parts(text: string): HighlightPart[] {
    return highlightParts(text, this.query());
  }

  onInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.query.set(v);
    this.open.set(true);
    this.q$.next(v.trim());
  }

  onKeydown(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.open.set(true);
      if (n) this.active.update((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) this.active.update((i) => (i <= 0 ? n - 1 : i - 1));
    } else if (e.key === 'Enter') {
      const r = this.results()[this.active()];
      if (r && this.showDropdown()) {
        e.preventDefault();
        this.go(r);
      }
      // otherwise let the native form submit to /search?q=
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (this.open()) this.open.set(false);
      else this.closeAll();
    }
  }

  onSubmit(e: Event): void {
    e.preventDefault();
    const q = this.query().trim();
    if (!q) return;
    this.closeAll();
    void this.router.navigate(['/search'], { queryParams: { q } });
  }

  onFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (next && this.host.nativeElement.contains(next)) return;
    this.open.set(false);
  }

  link(r: SearchResult): { commands: string[]; fragment?: string } {
    return { commands: ['/manual', r.pageId], fragment: r.matchedStep ? 'step-' + r.matchedStep.id : undefined };
  }

  href(r: SearchResult): string {
    return `/manual/${encodeURIComponent(r.pageId)}${r.matchedStep ? '#step-' + r.matchedStep.id : ''}`;
  }

  go(r: SearchResult, e?: Event): void {
    e?.preventDefault();
    const l = this.link(r);
    this.closeAll();
    void this.router.navigate(l.commands, { fragment: l.fragment });
  }

  openOverlay(): void {
    this.overlayOpen.set(true);
    setTimeout(() => this.inputEl()?.nativeElement.focus(), 30);
  }

  closeAll(): void {
    this.open.set(false);
    this.overlayOpen.set(false);
  }

  clear(): void {
    this.query.set('');
    this.results.set([]);
    this.searched.set(false);
    this.q$.next('');
    this.inputEl()?.nativeElement.focus();
  }
}
