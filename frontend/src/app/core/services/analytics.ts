import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import type { AnalyticsEventPayload } from '../models/page';

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  private readonly sessionId = crypto.randomUUID();
  private readonly anonymousId = this.loadAnonymousId();

  fire(payload: Omit<AnalyticsEventPayload, 'sessionId' | 'anonymousId'>) {
    const body: AnalyticsEventPayload = {
      ...payload,
      sessionId: this.sessionId,
      anonymousId: this.anonymousId,
    };
    this.http
      .post(`${this.base}/public/events`, body)
      .subscribe({ error: () => {} });
  }

  private loadAnonymousId(): string {
    const key = 'ha_anon_id';
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  }
}
