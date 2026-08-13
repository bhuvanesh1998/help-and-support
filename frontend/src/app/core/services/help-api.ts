import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from '../config/app-config.service';
import type { CategoriesResponse, PageResponse, TutorialsResponse, TutorialDetailResponse } from '../models/page';

@Injectable({ providedIn: 'root' })
export class HelpApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(AppConfigService).apiBaseUrl;

  getPageByRoute(routePath: string) {
    const url = `${this.base}/public/pages`;
    return this.http.get<PageResponse>(url, { params: { routePath } });
  }

  getAllTutorials() {
    return this.http.get<TutorialsResponse>(`${this.base}/public/tutorials`);
  }

  getTutorial(id: string) {
    return this.http.get<TutorialDetailResponse>(`${this.base}/public/tutorials/${id}`);
  }

  getCategories() {
    return this.http.get<CategoriesResponse>(`${this.base}/public/categories`);
  }
}
