export interface AdminUser {
  id: string;
  email: string;
  role: 'SUPER_ADMIN' | 'ADMIN';
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

/** Counts returned after restoring a backup .zip. */
export interface BackupRestoreSummary {
  categories: number;
  pages: number;
  steps: number;
  apiEndpoints: number;
  media: number;
  filesWritten: number;
}

/** Persisted defaults for the embeddable Help widget (Connect screen). */
export interface WidgetConfig {
  launcher: 'fab' | 'tab' | 'pill';
  icon: 'question' | 'chat' | 'book' | 'bulb' | 'info' | 'none';
  label: string;
  animation: 'slide' | 'slide-side' | 'scale' | 'fade' | 'none';
  position: 'right' | 'left';
  color: string;
  theme: 'auto' | 'light' | 'dark';
}

export interface AdminPage {
  id: string;
  routePath: string;
  slug: string | null;
  title: string;
  description: string | null;
  category?: string | null;
  categoryOrder?: number;
  metaTitle: string | null;
  metaDescription: string | null;
  keywords: string[];
  noIndex: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { steps: number };
  apiEndpoints?: AdminApiEndpoint[];
}

export interface AdminCategory {
  id: string;
  name: string;
  order: number;
  icon: string | null;
  description: string | null;
  pageCount?: number;
}

export interface AdminApiEndpoint {
  id: string;
  method: string;
  path: string;
  query: string | null;
  host: string | null;
  requestBody: string | null;
  status: number | null;
  contentType: string | null;
  responseSample: string | null;
  description: string | null;
  order: number;
}

export interface AdminStep {
  id: string;
  pageId: string;
  stepNumber: number;
  title: string;
  instructionsMd: string;
  imageUrl: string | null;
  mediaAssetId: string | null;
  createdAt: string;
}

export interface MediaAsset {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  publicUrl: string;
  altText: string | null;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; pages: number };
}

export interface AnalyticsSummary {
  period: { days: number; since: string };
  totalEvents: number;
  byType: Array<{ eventType: string; count: number }>;
  topRoutes: Array<{ routePath: string | null; views: number }>;
  dailyViews: Array<{ day: string; views: number }>;
}

export interface AnalyticsEvent {
  id: string;
  eventType: string;
  routePath: string | null;
  sessionId: string | null;
  durationMs: number | null;
  country: string | null;
  createdAt: string;
}

// ── AI Pipeline ───────────────────────────────────────────────────────────────

export type AiJobPhase = 'pending' | 'scraping' | 'drafting' | 'done' | 'error' | 'cancelled';

export interface AiPipelineConfig {
  baseUrl: string;
  appName: string;
  email: string;
  password: string;
  /** Optional per-run override; omitted when a stored credential is used. */
  anthropicKey?: string;
  model: string;
  navDepth: number;
  /** Open a visible browser and pause for manual captcha/login completion. */
  headed?: boolean;
  /** Pre-authenticated session to skip login + captcha (cookies / localStorage). */
  session?: AiSessionInjection;
}

export interface AiSessionInjection {
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>;
  localStorage?: Record<string, string>;
  startPath?: string;
}

// ── Exports ──────────────────────────────────────────────────────────────────

export type ExportFormat = 'pdf' | 'doc';

export interface ExportRecord {
  id: string;
  format: ExportFormat;
  status: 'pending' | 'ready' | 'error';
  title: string;
  pageCount: number;
  progress: number;
  filename: string | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AiCredentialStatus {
  connected: boolean;
  keyLast4: string | null;
  model: string | null;
  validatedAt: string | null;
  updatedAt: string | null;
}

// ── MCP connector ──────────────────────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpCallLog {
  tool: string;
  ok: boolean;
  detail: string;
  at: string;
}

export interface McpStatus {
  configured: boolean;
  enabled: boolean;
  tokenLast4: string | null;
  updatedAt: string | null;
  serverUrl: string;
  tools: McpToolInfo[];
  recentCalls: McpCallLog[];
}

export interface AiScreen {
  id: string;
  name: string;
  group: string;
  url: string;
  imageUrl: string | null;
  mediaId: string | null;
  capturedAt: string;
  dom: { heading: string; title: string };
}

export interface AiScreenGroup {
  id: string;
  name: string;
  screenIds: string[];
  routePath: string;
}

export interface AiDraftStep {
  stepNumber: number;
  title: string;
  instructionsMd: string;
  screenshotId: string;
  imageUrl: string | null;
}

export interface AiDraftTutorial {
  groupId: string;
  groupName: string;
  page: { title: string; description: string; routePath: string };
  steps: AiDraftStep[];
}

export interface AiJobSnapshot {
  id: string;
  phase: AiJobPhase;
  config: { baseUrl: string; appName: string; email: string; navDepth: number; model: string };
  screens: AiScreen[];
  groups: AiScreenGroup[];
  tutorials: AiDraftTutorial[];
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; at: string }>;
  error: string | null;
  createdAt: string;
}

/** Events streamed over SSE from the pipeline. */
export type AiPipelineEvent =
  | { type: 'phase'; phase: AiJobPhase; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'screen'; screen: AiScreen }
  | { type: 'group'; group: AiScreenGroup }
  | { type: 'draft'; tutorial: AiDraftTutorial }
  | { type: 'done'; totalScreens: number; totalTutorials: number }
  | { type: 'error'; message: string };
