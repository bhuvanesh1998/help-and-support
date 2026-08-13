import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from '../config/app-config.service';
import { safeUUID } from '../utils/uuid';
import type { AnalyticsEventPayload } from '../models/page';

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(AppConfigService).apiBaseUrl;

  private readonly sessionId = safeUUID();
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
      id = safeUUID();
      localStorage.setItem(key, id);
    }
    return id;
  }
}
