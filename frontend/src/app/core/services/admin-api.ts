import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppConfigService } from '../config/app-config.service';
import type {
  AdminCategory,
  AdminPage,
  BackupRestoreSummary,
  AdminStep,
  AdminUser,
  AiCredentialStatus,
  AiJobSnapshot,
  AiPipelineConfig,
  ExportFormat,
  ExportRecord,
  McpStatus,
  WidgetConfig,
  AnalyticsEvent,
  AnalyticsSummary,
  LoginResponse,
  MediaAsset,
  PaginatedResponse,
} from '../models/admin';

@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private readonly http = inject(HttpClient);
  private readonly b = `${inject(AppConfigService).apiBaseUrl}/admin`;

  // ── Auth ──────────────────────────────────────────────────────────────────
  login(email: string, password: string) {
    return this.http.post<LoginResponse>(`${this.b}/auth/login`, { email, password });
  }
  me() {
    return this.http.get<{ user: AdminUser }>(`${this.b}/auth/me`);
  }

  // ── Connect (embed widget config) ───────────────────────────────────────────
  getWidgetConfig() {
    return this.http.get<{ config: WidgetConfig }>(`${this.b}/connect`);
  }
  saveWidgetConfig(config: WidgetConfig) {
    return this.http.put<{ config: WidgetConfig }>(`${this.b}/connect`, config);
  }

  // ── Pages ─────────────────────────────────────────────────────────────────
  listPages(page = 1, limit = 20, category?: string) {
    const params: Record<string, string | number> = { page, limit };
    if (category) params['category'] = category;
    return this.http.get<PaginatedResponse<AdminPage>>(`${this.b}/pages`, { params });
  }
  getPage(id: string) {
    return this.http.get<{ page: AdminPage & { steps: AdminStep[] } }>(`${this.b}/pages/${id}`);
  }
  createPage(data: Partial<AdminPage>) {
    return this.http.post<{ page: AdminPage }>(`${this.b}/pages`, data);
  }
  updatePage(id: string, data: Partial<AdminPage>) {
    return this.http.patch<{ page: AdminPage }>(`${this.b}/pages/${id}`, data);
  }
  deletePage(id: string) {
    return this.http.delete(`${this.b}/pages/${id}`);
  }

  // ── Categories ──────────────────────────────────────────────────────────────
  listCategories() {
    return this.http.get<{ data: AdminCategory[] }>(`${this.b}/categories`);
  }
  createCategory(data: Partial<AdminCategory>) {
    return this.http.post<{ category: AdminCategory }>(`${this.b}/categories`, data);
  }
  updateCategory(id: string, data: Partial<AdminCategory>) {
    return this.http.patch<{ category: AdminCategory }>(`${this.b}/categories/${id}`, data);
  }
  deleteCategory(id: string) {
    return this.http.delete(`${this.b}/categories/${id}`);
  }
  reorderCategories(order: Array<{ id: string; order: number }>) {
    return this.http.post<{ ok: boolean }>(`${this.b}/categories/reorder`, { order });
  }

  // ── API endpoints (auto-captured API tab) ──────────────────────────────────
  deleteApiEndpoint(pageId: string, endpointId: string) {
    return this.http.delete(`${this.b}/pages/${pageId}/api-endpoints/${endpointId}`);
  }
  updateApiEndpoint(pageId: string, endpointId: string, data: { description?: string }) {
    return this.http.patch(`${this.b}/pages/${pageId}/api-endpoints/${endpointId}`, data);
  }

  // ── Steps ─────────────────────────────────────────────────────────────────
  listSteps(pageId: string) {
    return this.http.get<{ steps: AdminStep[] }>(`${this.b}/pages/${pageId}/steps`);
  }
  createStep(pageId: string, data: Partial<AdminStep>) {
    return this.http.post<{ step: AdminStep }>(`${this.b}/pages/${pageId}/steps`, data);
  }
  updateStep(pageId: string, stepId: string, data: Partial<AdminStep>) {
    return this.http.patch<{ step: AdminStep }>(`${this.b}/pages/${pageId}/steps/${stepId}`, data);
  }
  deleteStep(pageId: string, stepId: string) {
    return this.http.delete(`${this.b}/pages/${pageId}/steps/${stepId}`);
  }
  reorderSteps(pageId: string, order: Array<{ id: string; stepNumber: number }>) {
    return this.http.post<{ steps: AdminStep[] }>(
      `${this.b}/pages/${pageId}/steps/reorder`,
      { order },
    );
  }

  // ── Media ─────────────────────────────────────────────────────────────────
  listMedia(page = 1, limit = 20) {
    return this.http.get<PaginatedResponse<MediaAsset>>(`${this.b}/media`, {
      params: { page, limit },
    });
  }
  uploadMedia(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return this.http.post<{ asset: MediaAsset }>(`${this.b}/media`, fd);
  }
  getMedia(id: string) {
    return this.http.get<{ asset: MediaAsset }>(`${this.b}/media/${id}`);
  }
  updateMedia(id: string, altText: string) {
    return this.http.patch<{ asset: MediaAsset }>(`${this.b}/media/${id}`, { altText });
  }
  /** Save an annotated render (non-destructive): rendered PNG + editable shapes. */
  annotateMedia(
    id: string,
    rendered: Blob,
    annotations: unknown,
    width: number,
    height: number,
    altText?: string,
  ) {
    const fd = new FormData();
    fd.append('file', rendered, 'annotated.png');
    fd.append('annotations', JSON.stringify(annotations ?? []));
    fd.append('width', String(width));
    fd.append('height', String(height));
    if (altText !== undefined) fd.append('altText', altText);
    return this.http.post<{ asset: MediaAsset }>(`${this.b}/media/${id}/annotate`, fd);
  }
  /** Move an asset to the trash (soft delete). */
  deleteMedia(id: string) {
    return this.http.delete(`${this.b}/media/${id}`);
  }
  /** List trashed assets (soft-deleted, awaiting restore or 30-day purge). */
  listTrash(page = 1, limit = 20) {
    return this.http.get<PaginatedResponse<MediaAsset>>(`${this.b}/media/trash`, {
      params: { page, limit },
    });
  }
  /** Restore a trashed asset back to the library. */
  restoreMedia(id: string) {
    return this.http.post<{ asset: MediaAsset }>(`${this.b}/media/${id}/restore`, {});
  }
  /** Permanently delete a trashed asset (removes DB record + files). */
  purgeMedia(id: string) {
    return this.http.delete(`${this.b}/media/${id}/permanent`);
  }

  // ── Analytics ─────────────────────────────────────────────────────────────
  analyticsSummary(days = 30) {
    return this.http.get<AnalyticsSummary>(`${this.b}/analytics/summary`, { params: { days } });
  }
  analyticsEvents(page = 1, limit = 50) {
    return this.http.get<PaginatedResponse<AnalyticsEvent>>(`${this.b}/analytics/events`, {
      params: { page, limit },
    });
  }

  // ── AI Pipeline ─────────────────────────────────────────────────────────────
  startAiJob(config: AiPipelineConfig) {
    return this.http.post<{ jobId: string }>(`${this.b}/ai-pipeline/jobs`, config);
  }
  getAiJob(id: string) {
    return this.http.get<AiJobSnapshot>(`${this.b}/ai-pipeline/jobs/${id}`);
  }
  cancelAiJob(id: string) {
    return this.http.post<{ cancelled: boolean }>(`${this.b}/ai-pipeline/jobs/${id}/cancel`, {});
  }
  /** Full SSE URL for an EventSource (token passed in query — EventSource can't set headers). */
  aiStreamUrl(jobId: string, token: string): string {
    return `${this.b}/ai-pipeline/jobs/${jobId}/stream?token=${encodeURIComponent(token)}`;
  }
  /** Stored Claude credential — connect once, reuse for every run. */
  getAiCredential() {
    return this.http.get<AiCredentialStatus>(`${this.b}/ai-pipeline/credential`);
  }
  saveAiCredential(data: { anthropicKey: string; model: string }) {
    return this.http.put<AiCredentialStatus>(`${this.b}/ai-pipeline/credential`, data);
  }
  deleteAiCredential() {
    return this.http.delete<{ disconnected: boolean }>(`${this.b}/ai-pipeline/credential`);
  }

  // ── MCP connector ───────────────────────────────────────────────────────────
  getMcpStatus() {
    return this.http.get<McpStatus>(`${this.b}/mcp`);
  }
  revealMcpToken() {
    return this.http.get<{ token: string }>(`${this.b}/mcp/token`);
  }
  generateMcpToken() {
    return this.http.post<{ token: string }>(`${this.b}/mcp/token`, {});
  }
  setMcpEnabled(enabled: boolean) {
    return this.http.patch<{ enabled: boolean }>(`${this.b}/mcp`, { enabled });
  }
  revokeMcp() {
    return this.http.delete<{ revoked: boolean }>(`${this.b}/mcp`);
  }
  /** Download the browser-extension connector as a .zip (auth header via interceptor). */
  downloadExtension() {
    return this.http.get(`${this.b}/mcp/extension`, { responseType: 'blob' });
  }

  // ── Exports ───────────────────────────────────────────────────────────────
  startExport(format: ExportFormat, pageIds?: string[]) {
    return this.http.post<{ id: string }>(`${this.b}/exports`, { format, pageIds });
  }
  listExports() {
    return this.http.get<{ data: ExportRecord[] }>(`${this.b}/exports`);
  }
  deleteExport(id: string) {
    return this.http.delete(`${this.b}/exports/${id}`);
  }
  /** Fetch the generated file as a blob (auth header attached by the interceptor). */
  downloadExport(id: string) {
    return this.http.get(`${this.b}/exports/${id}/download`, { responseType: 'blob' });
  }

  // ── Backup / restore (full content + images) ────────────────────────────────
  /** Download a .zip backup of all content and images. */
  downloadBackup() {
    return this.http.get(`${this.b}/exports/backup`, { responseType: 'blob' });
  }
  /** Restore from a backup .zip — content is upserted, images written to disk. */
  importBackup(file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<{ ok: boolean; summary: BackupRestoreSummary }>(`${this.b}/exports/import`, form);
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  listUsers() {
    return this.http.get<{ users: AdminUser[] }>(`${this.b}/users`);
  }
  createUser(data: { email: string; password: string; role: string }) {
    return this.http.post<{ user: AdminUser }>(`${this.b}/users`, data);
  }
  updateUser(id: string, data: Partial<{ password: string; isActive: boolean; role: string }>) {
    return this.http.patch<{ user: AdminUser }>(`${this.b}/users/${id}`, data);
  }
  deleteUser(id: string) {
    return this.http.delete(`${this.b}/users/${id}`);
  }
}
