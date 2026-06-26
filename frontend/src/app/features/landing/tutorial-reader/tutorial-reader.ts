import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { renderStepMarkdown } from '../../../core/utils/step-markdown';
import { ImageViewer } from '../../../core/components/image-viewer/image-viewer';
import { HelpApiService } from '../../../core/services/help-api';
import type { ApiEndpoint, Page, TutorialsResponse } from '../../../core/models/page';

type TutorialListItem = TutorialsResponse['tutorials'][number];

@Component({
  selector: 'ha-tutorial-reader',
  imports: [RouterLink, ImageViewer],
  templateUrl: './tutorial-reader.html',
  styleUrl: './tutorial-reader.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TutorialReader implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api   = inject(HelpApiService);

  readonly loading      = signal(true);
  readonly tutorial     = signal<Page | null>(null);
  readonly activeStepId = signal<string>('');
  readonly allTutorials = signal<TutorialListItem[]>([]);

  /** Full-screen image viewer state. */
  readonly viewerSrc = signal<string | null>(null);
  readonly stepImages = computed<string[]>(() =>
    (this.tutorial()?.steps ?? []).map((s) => s.imageUrl).filter((u): u is string => !!u),
  );

  /** Which tab is showing: the step-by-step manual, or the API reference. */
  readonly activeTab    = signal<'manual' | 'api'>('manual');
  readonly apiEndpoints = computed<ApiEndpoint[]>(() => this.tutorial()?.apiEndpoints ?? []);
  readonly hasApi       = computed(() => this.apiEndpoints().length > 0);

  setTab(tab: 'manual' | 'api'): void {
    this.activeTab.set(tab);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }

  /** CSS modifier for the coloured HTTP-method badge. */
  methodClass(method: string): string {
    return 'api-method api-method--' + (method || 'get').toLowerCase().replace(/[^a-z]/g, '');
  }

  private observer?: IntersectionObserver;

  // Step Markdown is untrusted (AI/scraped/admin-authored). We expose plain
  // HTML strings and bind them with [innerHTML], so Angular's sanitizer strips
  // <script>/event handlers/javascript: URLs — never bypassSecurityTrustHtml.
  readonly stepHtmls = computed(() => {
    const t = this.tutorial();
    const map = new Map<string, string>();
    if (!t) return map;
    for (const step of t.steps) {
      map.set(step.id, renderStepMarkdown(step.instructionsMd, step.title));
    }
    return map;
  });

  // ── Prev / next tutorial (by position in the published list) ────────────────
  private readonly currentIndex = computed(() => {
    const cur = this.tutorial();
    const list = this.allTutorials();
    if (!cur || !list.length) return -1;
    return list.findIndex((x) => x.id === cur.id);
  });

  readonly prevTutorial = computed<TutorialListItem | null>(() => {
    const i = this.currentIndex();
    return i > 0 ? this.allTutorials()[i - 1] : null;
  });

  readonly nextTutorial = computed<TutorialListItem | null>(() => {
    const list = this.allTutorials();
    const i = this.currentIndex();
    return i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  });

  constructor() {
    // React to id changes so prev/next navigation reloads (the component is
    // reused across /tutorials/:id, so snapshot-once would not refresh).
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((pm) => {
      this.loadTutorial(pm.get('id') ?? '');
    });

    this.api.getAllTutorials().subscribe({
      next: (res) => this.allTutorials.set(res.tutorials),
      error: () => { /* prev/next simply won't show */ },
    });

    // (Re)build the scrollspy whenever the loaded tutorial changes.
    effect(() => {
      const t = this.tutorial();
      if (!t?.steps.length) return;
      queueMicrotask(() => this.setupScrollSpy());
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  private loadTutorial(id: string): void {
    this.loading.set(true);
    this.tutorial.set(null);
    this.activeTab.set('manual');
    this.observer?.disconnect();
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });

    this.api.getTutorial(id).subscribe({
      next: (res) => {
        this.tutorial.set(res.tutorial);
        this.loading.set(false);
        this.activeStepId.set(res.tutorial.steps[0]?.id ?? '');
      },
      error: () => this.loading.set(false),
    });
  }

  scrollToStep(stepId: string, event: Event): void {
    event.preventDefault();
    this.activeStepId.set(stepId);
    document.getElementById('step-' + stepId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  htmlFor(stepId: string): string {
    return this.stepHtmls().get(stepId) ?? '';
  }

  private setupScrollSpy(): void {
    this.observer?.disconnect();
    const sections = document.querySelectorAll<HTMLElement>('[id^="step-"]');
    if (!sections.length) return;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.activeStepId.set(entry.target.id.replace('step-', ''));
          }
        }
      },
      { threshold: 0.25, rootMargin: '-60px 0px -55% 0px' },
    );

    sections.forEach((s) => this.observer!.observe(s));
  }
}
