import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { HelpApiService } from '../../../core/services/help-api';
import { ThemeService } from '../../../core/services/theme.service';
import type { CategorySummary, TutorialsResponse } from '../../../core/models/page';

type Tutorial = TutorialsResponse['tutorials'][number];

@Component({
  selector: 'ha-landing',
  imports: [RouterLink, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Landing implements OnInit {
  private readonly api    = inject(HelpApiService);
  private readonly router = inject(Router);
  readonly theme          = inject(ThemeService);

  readonly loading    = signal(true);
  readonly tutorials  = signal<Tutorial[]>([]);
  readonly totalSteps = computed(() =>
    this.tutorials().reduce((acc, t) => acc + t.steps.length, 0),
  );

  /** Module summary cards (level 1). */
  readonly categorySummaries = signal<CategorySummary[]>([]);

  /** Which category is open (level 2); null = show the summary cards. */
  readonly activeCategory = signal<string | null>(null);

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
    this.activeCategory.set(name);
    if (typeof window !== 'undefined') {
      document.getElementById('tutorials')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  backToCategories(): void {
    this.activeCategory.set(null);
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
