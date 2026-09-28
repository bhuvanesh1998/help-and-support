import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  DOCUMENT,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { HelpApiService } from '../../../core/services/help-api';
import { ThemeService } from '../../../core/services/theme.service';
import { SiteSettingsService } from '../../../core/services/site-settings.service';
import { SiteSearch } from '../../search/site-search/site-search';
import { SupportForm } from '../../support/support-form/support-form';
import type { CategorySummary, TutorialsResponse } from '../../../core/models/page';

type Tutorial = TutorialsResponse['tutorials'][number];

@Component({
  selector: 'ha-landing',
  imports: [RouterLink, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, SiteSearch, SupportForm],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Landing implements OnInit {
  private readonly api    = inject(HelpApiService);
  private readonly router = inject(Router);
  readonly theme          = inject(ThemeService);
  readonly site           = inject(SiteSettingsService);
  private readonly title  = inject(Title);
  private readonly meta   = inject(Meta);
  private readonly doc    = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** Floating nav tightens up once the page has scrolled. */
  readonly scrolled = signal(false);

  readonly loading    = signal(true);
  readonly tutorials  = signal<Tutorial[]>([]);
  readonly totalSteps = computed(() =>
    this.tutorials().reduce((acc, t) => acc + t.steps.length, 0),
  );

  /** Module summary cards (level 1). */
  readonly categorySummaries = signal<CategorySummary[]>([]);

  /** Which category is open (level 2); null = show the summary cards. */
  readonly activeCategory = signal<string | null>(null);

  /** "New" view: show every recently-added manual across all modules. */
  readonly newOnly = signal(false);

  /** A manual counts as "new" for this many days after it is created. */
  private static readonly NEW_DAYS = 14;

  isNew(t: Tutorial): boolean {
    if (!t.createdAt) return false;
    const created = new Date(t.createdAt).getTime();
    if (Number.isNaN(created)) return false;
    const ageMs = Date.now() - created;
    return ageMs >= 0 && ageMs <= Landing.NEW_DAYS * 24 * 60 * 60 * 1000;
  }

  /** All new manuals, newest first — powers the "New" filter view. */
  readonly newManuals = computed(() =>
    this.tutorials()
      .filter((t) => this.isNew(t))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
  );

  readonly newCount = computed(() => this.newManuals().length);

  /** Manuals inside the open category, sorted by title. */
  readonly activeManuals = computed(() => {
    const cat = this.activeCategory();
    if (!cat) return [];
    return this.tutorials()
      .filter((t) => (t.category ?? 'General') === cat)
      .sort((a, b) => a.title.localeCompare(b.title));
  });

  readonly activeCategoryMeta = computed(() =>
    this.categorySummaries().find((c) => c.name === this.activeCategory()) ?? null,
  );

  ngOnInit(): void {
    this.site.loadSettings();
    this.site.loadSupport();
    const brand = this.site.settings().brandName;
    this.title.setTitle(`${brand} User Manual · Step-by-step guides & support`);
    const desc = 'Step-by-step user manuals for every screen, searchable by keyword, with 24x7 support ticketing.';
    this.meta.updateTag({ name: 'description', content: desc });
    this.meta.updateTag({ property: 'og:title', content: `${brand} User Manual` });
    this.meta.updateTag({ property: 'og:description', content: desc });
    this.meta.updateTag({ name: 'robots', content: 'index, follow' });

    const win = this.doc.defaultView;
    if (win) {
      const onScroll = () => this.scrolled.set(win.scrollY > 8);
      win.addEventListener('scroll', onScroll, { passive: true });
      this.destroyRef.onDestroy(() => win.removeEventListener('scroll', onScroll));
      onScroll();
    }
    this.api.getAllTutorials().subscribe({
      next:  res => { this.tutorials.set(res.tutorials); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
    this.api.getCategories().subscribe({
      next: res => this.categorySummaries.set(res.categories),
      error: () => { /* summary cards just won't show */ },
    });
  }

  openCategory(name: string): void {
    this.newOnly.set(false);
    this.activeCategory.set(name);
    if (typeof window !== 'undefined') {
      document.getElementById('tutorials')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  backToCategories(): void {
    this.activeCategory.set(null);
    this.newOnly.set(false);
  }

  /** Toggle the flat "New manuals" view (mutually exclusive with a category). */
  showNew(): void {
    this.activeCategory.set(null);
    this.newOnly.set(true);
    if (typeof window !== 'undefined') {
      document.getElementById('tutorials')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  open(id: string): void {
    void this.router.navigate(['/manual', id]);
  }

  preview(md: string, len = 120): string {
    return md
      .replace(/^#+\s+/gm, '')
      .replace(/[*`_>[\]]/g, '')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, len);
  }
}
