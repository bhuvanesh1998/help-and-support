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
  VoiceoverConfig,
  TtsVoice,
  VoAudioClip,
  VoCredentialId,
  VoKeyStatus,
  VoProviderId,
  VoiceoverSettings,
  VoJobSnapshot,
  VoScriptDetail,
  VoScriptFilters,
  VoScriptSummary,
  VoSegment,
  VoTone,
  VoUsageReport,
  AdminRole,
  PermissionGroup,
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

  // ── Roles & permissions ─────────────────────────────────────────────────────
  /** Roles plus the permission catalogue, so the UI never hardcodes the list. */
  listRoles() {
    return this.http.get<{ roles: AdminRole[]; groups: PermissionGroup[] }>(`${this.b}/roles`);
  }
  createRole(body: { name: string; description: string; permissions: string[] }) {
    return this.http.post<{ role: AdminRole }>(`${this.b}/roles`, body);
  }
  updateRole(id: string, body: { name?: string; description?: string; permissions?: string[] }) {
    return this.http.patch<{ role: AdminRole }>(`${this.b}/roles/${id}`, body);
  }
  deleteRole(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.b}/roles/${id}`);
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

  // ── Voiceover Studio ────────────────────────────────────────────────────────
  getVoiceoverConfig() {
    return this.http.get<VoiceoverConfig>(`${this.b}/voiceover/config`);
  }
  saveVoiceoverSettings(settings: Partial<VoiceoverSettings>) {
    return this.http.put<{ settings: VoiceoverSettings }>(`${this.b}/voiceover/settings`, settings);
  }
  /** Drop the saved row so the server's environment baseline applies again. */
  resetVoiceoverSettings() {
    return this.http.delete<{ settings: VoiceoverSettings }>(`${this.b}/voiceover/settings`);
  }
  /** Upload the walkthrough video and start a script job. */
  startVoiceoverJob(video: File, data: { appName: string; audience: string; tone: VoTone }) {
    const form = new FormData();
    form.append('video', video);
    form.append('appName', data.appName);
    form.append('audience', data.audience);
    form.append('tone', data.tone);
    return this.http.post<{ jobId: string }>(`${this.b}/voiceover/jobs`, form);
  }
  getVoiceoverJob(id: string) {
    return this.http.get<VoJobSnapshot>(`${this.b}/voiceover/jobs/${id}`);
  }
  cancelVoiceoverJob(id: string) {
    return this.http.post<{ cancelled: boolean }>(`${this.b}/voiceover/jobs/${id}/cancel`, {});
  }
  /** Full SSE URL for an EventSource (token in query — EventSource can't set headers). */
  voiceoverStreamUrl(jobId: string, token: string): string {
    return `${this.b}/voiceover/jobs/${jobId}/stream?token=${encodeURIComponent(token)}`;
  }
  /**
   * The script library — searched and filtered server-side so results stay
   * correct as the collection grows.
   */
  listVoiceoverScripts(query: {
    search?: string;
    status?: string;
    tone?: string;
    provider?: string;
  } = {}) {
    const params: Record<string, string> = {};
    if (query.search) params['search'] = query.search;
    if (query.status) params['status'] = query.status;
    if (query.tone) params['tone'] = query.tone;
    if (query.provider) params['provider'] = query.provider;
    return this.http.get<{ scripts: VoScriptSummary[]; filters: VoScriptFilters }>(
      `${this.b}/voiceover/scripts`,
      { params },
    );
  }
  // ── Narration audio (ElevenLabs) ──────────────────────────────────────────
  /** Voices and TTS models on the connected account. */
  listTtsVoices() {
    return this.http.get<{ voices: TtsVoice[]; models: string[]; defaultModel: string }>(
      `${this.b}/voiceover/tts/voices`,
    );
  }
  listScriptAudio(scriptId: string) {
    return this.http.get<{ audio: VoAudioClip[] }>(`${this.b}/voiceover/scripts/${scriptId}/audio`);
  }
  /** Render one segment. One call per line, so a bad take is a single re-render. */
  renderSegmentAudio(
    scriptId: string,
    index: number,
    body: { voiceId: string; voiceName: string; modelId?: string },
  ) {
    return this.http.post<{ clip: VoAudioClip }>(
      `${this.b}/voiceover/scripts/${scriptId}/audio/${index}`,
      body,
    );
  }
  deleteScriptAudio(scriptId: string) {
    return this.http.delete<{ deleted: number }>(
      `${this.b}/voiceover/scripts/${scriptId}/audio`,
    );
  }
  /** Short listening test, not stored server-side. Returns raw audio. */
  sampleVoice(body: { voiceId: string; modelId?: string; text?: string }) {
    return this.http.post(`${this.b}/voiceover/tts/sample`, body, { responseType: 'blob' });
  }
  /** Stitch the rendered lines into one track matching the video length. */
  buildAudioTimeline(scriptId: string) {
    return this.http.post<{ clip: VoAudioClip; lines: number }>(
      `${this.b}/voiceover/scripts/${scriptId}/audio/timeline`,
      {},
    );
  }
  /** Save a hand-edited narration line. */
  updateSegmentText(scriptId: string, index: number, script: string) {
    return this.http.patch<{ segment: VoSegment }>(
      `${this.b}/voiceover/scripts/${scriptId}/segments/${index}`,
      { script },
    );
  }
  voiceoverAudioExportUrl(scriptId: string, token: string): string {
    return `${this.b}/voiceover/scripts/${scriptId}/audio/export?token=${encodeURIComponent(token)}`;
  }

  /** Re-run a script's stored frames in another tone. Returns a job to watch. */
  regenerateVoiceoverScript(id: string, tone: VoTone) {
    return this.http.post<{ jobId: string }>(`${this.b}/voiceover/scripts/${id}/regenerate`, {
      tone,
    });
  }
  getVoiceoverScript(id: string) {
    return this.http.get<{ script: VoScriptDetail }>(`${this.b}/voiceover/scripts/${id}`);
  }
  deleteVoiceoverScript(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.b}/voiceover/scripts/${id}`);
  }
  /** Download URL — plain navigation, so the token travels in the query. */
  voiceoverExportUrl(scriptId: string, token: string): string {
    return `${this.b}/voiceover/scripts/${scriptId}/export?token=${encodeURIComponent(token)}`;
  }
  /** Provider API keys. Validated server-side; the key is never read back. */
  connectVoiceoverKey(provider: VoCredentialId, apiKey: string) {
    return this.http.put<{ keys: VoKeyStatus[] }>(`${this.b}/voiceover/keys/${provider}`, {
      apiKey,
    });
  }
  disconnectVoiceoverKey(provider: VoCredentialId) {
    return this.http.delete<{ keys: VoKeyStatus[] }>(`${this.b}/voiceover/keys/${provider}`);
  }
  /** Models the connected account can actually use, asked of the provider. */
  listProviderModels(provider: VoProviderId) {
    return this.http.get<{ models: string[] }>(`${this.b}/voiceover/models/${provider}`);
  }
  /** Consumption over the last `days`, in provider units. */
  getVoiceoverUsage(days: number) {
    return this.http.get<VoUsageReport>(`${this.b}/voiceover/usage`, {
      params: { days: String(days) },
    });
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
  createUser(data: { email: string; password: string; role: string; roleId?: string | null }) {
    return this.http.post<{ user: AdminUser }>(`${this.b}/users`, data);
  }
  updateUser(
    id: string,
    data: Partial<{ password: string; isActive: boolean; role: string; roleId: string | null }>,
  ) {
    return this.http.patch<{ user: AdminUser }>(`${this.b}/users/${id}`, data);
  }
  deleteUser(id: string) {
    return this.http.delete(`${this.b}/users/${id}`);
  }
}
