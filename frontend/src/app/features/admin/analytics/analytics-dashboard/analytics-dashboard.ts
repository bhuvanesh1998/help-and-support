import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe, TitleCasePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import type { AnalyticsSummary, AnalyticsEvent, PaginatedResponse } from '../../../../core/models/admin';

@Component({
  selector: 'ha-analytics-dashboard',
  imports: [DatePipe, DecimalPipe, TitleCasePipe, MatButtonModule, MatIconModule, MatTableModule, MatTooltipModule],
  templateUrl: './analytics-dashboard.html',
  styleUrl: './analytics-dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalyticsDashboard implements OnInit {
  private readonly api = inject(AdminApiService);

  readonly loading       = signal(true);
  readonly summary       = signal<AnalyticsSummary | null>(null);
  readonly events        = signal<PaginatedResponse<AnalyticsEvent> | null>(null);
  readonly selectedDays  = signal(30);

  readonly eventColumns = ['eventType', 'routePath', 'sessionId', 'durationMs', 'country', 'createdAt'];

  readonly maxDailyViews = computed(() =>
    Math.max(...(this.summary()?.dailyViews ?? []).map(d => d.views), 1),
  );

  readonly maxRouteViews = computed(() =>
    Math.max(...(this.summary()?.topRoutes ?? []).map(r => r.views), 1),
  );

  readonly totalPageViews = computed(() =>
    this.summary()?.byType.find(t => t.eventType === 'page_view')?.count ?? 0,
  );

  readonly eventTypeIcons: Record<string, string> = {
    page_view:       'visibility',
    tutorial_open:   'play_circle',
    tutorial_close:  'stop_circle',
    step_view:       'chevron_right',
    help_open:       'help',
    search:          'search',
  };

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.analyticsSummary(this.selectedDays()).subscribe({
      next: res => this.summary.set(res),
    });
    this.api.analyticsEvents(1, 50).subscribe({
      next: res  => { this.events.set(res); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
  }

  setDays(d: number): void {
    this.selectedDays.set(d);
    this.load();
  }

  barHeight(views: number): string {
    return `${Math.max(Math.round((views / this.maxDailyViews()) * 100), 2)}%`;
  }

  routeBarWidth(views: number): string {
    return `${Math.round((views / this.maxRouteViews()) * 100)}%`;
  }

  iconFor(eventType: string): string {
    return this.eventTypeIcons[eventType] ?? 'radio_button_unchecked';
  }
}
