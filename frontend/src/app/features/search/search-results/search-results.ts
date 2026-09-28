import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SiteSettingsService } from '../../../core/services/site-settings.service';
import type { SearchResult } from '../../../core/models/support';
import { SiteSearch } from '../site-search/site-search';
import { highlightParts, type HighlightPart } from '../highlight';

/** Crawlable /search?q= results page — every result is a real <a href>. */
@Component({
  selector: 'ha-search-results',
  imports: [RouterLink, SiteSearch],
  templateUrl: './search-results.html',
  styleUrl: './search-results.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchResults implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly doc = inject(DOCUMENT);
  readonly site = inject(SiteSettingsService);

  readonly q = signal('');
  readonly loading = signal(false);
  readonly results = signal<SearchResult[]>([]);
  readonly failed = signal(false);

  private canonical: HTMLLinkElement | null = null;

  constructor() {
    this.site.loadSettings();
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((pm) => {
      const q = (pm.get('q') ?? '').trim();
      this.q.set(q);
      this.setSeo(q);
      this.run(q);
    });
  }

  ngOnDestroy(): void {
    this.canonical?.remove();
  }

  parts(text: string): HighlightPart[] {
    return highlightParts(text, this.q());
  }

  fragment(r: SearchResult): string | undefined {
    return r.matchedStep ? 'step-' + r.matchedStep.id : undefined;
  }

  private run(q: string): void {
    this.failed.set(false);
    if (q.length < 2) {
      this.results.set([]);
      return;
    }
    this.loading.set(true);
    this.site.search(q, 50).subscribe({
      next: (r) => { this.results.set(r); this.loading.set(false); },
      error: () => { this.results.set([]); this.failed.set(true); this.loading.set(false); },
    });
  }

  private setSeo(q: string): void {
    const brand = this.site.settings().brandName;
    const t = q ? `Search results for “${q}” · ${brand} User Manual` : `Search · ${brand} User Manual`;
    const d = q
      ? `User manual pages and step-by-step guides matching “${q}”.`
      : 'Search every user manual page, step and keyword.';
    this.title.setTitle(t);
    this.meta.updateTag({ name: 'description', content: d });
    this.meta.updateTag({ property: 'og:title', content: t });
    this.meta.updateTag({ property: 'og:description', content: d });
    // Result pages for arbitrary queries shouldn't be indexed; links are still followed.
    this.meta.updateTag({ name: 'robots', content: 'noindex, follow' });

    const origin = this.doc.defaultView?.location.origin ?? '';
    const href = `${origin}/search${q ? '?q=' + encodeURIComponent(q) : ''}`;
    if (!this.canonical) {
      this.canonical = this.doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (!this.canonical) {
        this.canonical = this.doc.createElement('link');
        this.canonical.rel = 'canonical';
        this.doc.head.appendChild(this.canonical);
      }
    }
    this.canonical.href = href;
  }
}
