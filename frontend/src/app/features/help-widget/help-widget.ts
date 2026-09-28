import { YoutubePlayer } from '../../core/components/youtube-player/youtube-player';
import type { PageVideo } from '../../core/models/page';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { HelpApiService } from '../../core/services/help-api';
import { AnalyticsService } from '../../core/services/analytics';
import type { Page, TutorialStep } from '../../core/models/page';
import { StepCard } from './step-card/step-card';
import { SiteSettingsService } from '../../core/services/site-settings.service';
import { SupportForm } from '../support/support-form/support-form';

type LoadState = 'idle' | 'loading' | 'loaded' | 'not-found' | 'error';

@Component({
  selector: 'ha-help-widget',
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule, StepCard, YoutubePlayer, SupportForm],
  templateUrl: './help-widget.html',
  styleUrl: './help-widget.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpWidget implements OnInit {
  private readonly api = inject(HelpApiService);
  private readonly analytics = inject(AnalyticsService);
  private readonly document = inject(DOCUMENT);
  private readonly site = inject(SiteSettingsService);

  readonly supportAvailable = this.site.supportAvailable;
  readonly tab = signal<'guide' | 'ticket'>('guide');
  readonly hostUrl = signal<string | null>(null);

  readonly isOpen = signal(false);
  // True when this app is itself running inside the embeddable panel (/embed).
  // That page IS the help panel, so a nested floating widget would overlap its
  // own controls (e.g. the Next button) — suppress it entirely there.
  readonly suppressed = signal(false);
  readonly state = signal<LoadState>('idle');
  readonly page = signal<Page | null>(null);

  /** Overview videos lead on the first step; after that each step shows its own. */
  readonly currentVideos = computed<PageVideo[]>(() => {
    const videos = this.page()?.videos ?? [];
    const stepId = this.currentStep()?.id;
    const pinned = videos.filter((v) => v.stepId && v.stepId === stepId);
    return this.activeStep() === 0 ? [...videos.filter((v) => !v.stepId), ...pinned] : pinned;
  });
  readonly activeStep = signal<number>(0);

  readonly currentStep = computed<TutorialStep | null>(() => {
    const p = this.page();
    if (!p) return null;
    return p.steps[this.activeStep()] ?? null;
  });

  readonly totalSteps = computed(() => this.page()?.steps.length ?? 0);
  readonly hasNext = computed(() => this.activeStep() < this.totalSteps() - 1);
  readonly hasPrev = computed(() => this.activeStep() > 0);
  readonly progress = computed(() =>
    this.totalSteps() > 0 ? ((this.activeStep() + 1) / this.totalSteps()) * 100 : 0,
  );

  private currentRoute = '';

  ngOnInit(): void {
    this.currentRoute = this.document.defaultView?.location.pathname ?? '/';
    this.suppressed.set(this.currentRoute.startsWith('/embed'));
  }

  toggle(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
      return;
    }
    this.isOpen.set(true);
    this.site.loadSupport();
    this.hostUrl.set(this.document.defaultView?.location.href ?? null);
    if (this.state() === 'idle') {
      this.loadContent();
    }
  }

  close(): void {
    this.isOpen.set(false);
  }

  nextStep(): void {
    if (!this.hasNext()) return;
    this.activeStep.update((n) => n + 1);
    this.fireStepView();
  }

  prevStep(): void {
    if (!this.hasPrev()) return;
    this.activeStep.update((n) => n - 1);
    this.fireStepView();
  }

  private loadContent(): void {
    this.state.set('loading');
    this.api.getPageByRoute(this.currentRoute).subscribe({
      next: (res) => {
        this.page.set(res.page);
        this.activeStep.set(0);
        this.state.set('loaded');
        this.analytics.fire({
          eventType: 'HELP_OPENED',
          routePath: this.currentRoute,
          pageId: res.page.id,
        });
        this.fireStepView();
      },
      error: (err) => {
        this.state.set(err.status === 404 ? 'not-found' : 'error');
      },
    });
  }

  private fireStepView(): void {
    const p = this.page();
    const step = this.currentStep();
    if (!p || !step) return;
    this.analytics.fire({
      eventType: 'STEP_VIEWED',
      routePath: this.currentRoute,
      pageId: p.id,
      tutorialStepId: step.id,
    });
  }
}
