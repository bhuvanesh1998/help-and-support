export interface AdminUser {
  id: string;
  email: string;
  /** Account tier. SUPER_ADMIN holds every permission unconditionally. */
  role: 'SUPER_ADMIN' | 'ADMIN';
  /** Assigned role; null means the legacy admin fallback. */
  roleId?: string | null;
  roleName?: string | null;
  /**
   * Effective permission keys, from /auth/me. Advisory only — used to hide what
   * the account cannot use; the server re-checks every request.
   */
  permissions?: string[];
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** ── Roles ────────────────────────────────────────────────────────────────── */

export interface PermissionDef {
  key: string;
  label: string;
  description: string;
  implies?: string[];
}

export interface PermissionGroup {
  key: string;
  label: string;
  permissions: PermissionDef[];
}

export interface AdminRole {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  /** Built-in roles: renameable, but their permission set is fixed. */
  isSystem: boolean;
  userCount: number;
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
  isPublished: boolean;
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

/** A single annotation shape drawn over an image (coords in natural pixels). */
export interface ImageAnnotation {
  id?: string;
  type: 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'badge' | 'blur';
  color: string;
  thickness: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
  points?: Array<{ x: number; y: number }>;
  text?: string;
  fontSize?: number;
  number?: number;
  /** Layer state. */
  hidden?: boolean;
  groupId?: string | null;
  /** Auto/edited caption shown around the shape. */
  label?: string;
  labelPos?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  /** Blur strength (px) for blur shapes; falls back to thickness when absent. */
  blurRadius?: number;
}

export interface MediaAsset {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  publicUrl: string;
  altText: string | null;
  createdAt: string;
  /** Set when the image has been edited in the annotator. */
  editedAt?: string | null;
  /** Editable annotation shapes (present on the detail endpoint). */
  annotations?: ImageAnnotation[] | null;
  /** Untouched base image the annotations are composited over. */
  originalUrl?: string | null;
  /** Set when the asset is in the trash (soft-deleted). */
  deletedAt?: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; pages: number; retentionDays?: number };
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

// ── Voiceover Studio ─────────────────────────────────────────────────────────

export type VoJobPhase =
  | 'pending'
  | 'probing'
  | 'extracting'
  | 'scripting'
  | 'done'
  | 'error'
  | 'cancelled';

export type VoTone = 'instructional' | 'marketing' | 'onboarding';

export type VoEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Vision providers that can read the frames and write the script. */
export type VoProviderId = 'anthropic' | 'openai' | 'gemini';

/** Credentials the feature stores: vision providers plus text-to-speech. */
export type VoCredentialId = VoProviderId | 'elevenlabs';

/** A voice on the connected ElevenLabs account. */
export interface TtsVoice {
  voiceId: string;
  name: string;
  category: string | null;
  previewUrl: string | null;
}

/** One rendered narration clip. `kind` is 'segment' or the stitched 'timeline'. */
export interface VoAudioClip {
  kind: string;
  segmentIndex: number;
  /** The wording this clip speaks; for a timeline, its build number. */
  segmentVersion: number;
  /** Timeline clips only: the takes mixed in, for staleness checks. */
  sourceSignature?: string | null;
  voiceId: string;
  voiceName: string;
  modelId: string;
  publicUrl: string;
  sizeBytes: number;
  createdAt: string;
}

export interface VoProviderMeta {
  id: VoProviderId;
  label: string;
  defaultModel: string;
  suggestedModels: string[];
  keyHint: string;
}

/** Per-provider key connection status. Never carries the key itself. */
export interface VoKeyStatus {
  provider: VoCredentialId;
  label: string;
  connected: boolean;
  keyLast4: string | null;
  validatedAt: string | null;
  keyHint: string;
  suggestedModels: string[];
  defaultModel: string;
}

/** Admin-editable tunables, persisted server-side. */
export interface VoiceoverSettings {
  maxVideoUploadMb: number;
  provider: VoProviderId;
  model: string;
  effort: VoEffort;
  maxTokens: number;
  maxFrames: number;
  framesPerBatch: number;
  frameWidth: number;
  frameQuality: number;
  sceneThreshold: number;
  minFrameGapSec: number;
  minSegmentSec: number;
  maxSegmentSec: number;
  wordsPerMinute: number;
  jobRetentionMinutes: number;
}

/** Allowed range per numeric field, enforced server-side and mirrored in inputs. */
export type VoiceoverBounds = Record<string, { min: number; max: number }>;

/** Effective settings plus capabilities, so the UI never hardcodes limits. */
export interface VoiceoverConfig {
  settings: VoiceoverSettings;
  bounds: VoiceoverBounds;
  providers: VoProviderMeta[];
  keys: VoKeyStatus[];
  efforts: VoEffort[];
  tones: VoTone[];
  /** The environment baseline, offered as "reset to defaults". */
  envDefaults: VoiceoverSettings;
}

export interface VideoMeta {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface VoSegment {
  index: number;
  startSec: number;
  endSec: number;
  onScreen: string;
  script: string;
  wordBudget: number;
  wordCount: number;
  imageUrl: string | null;
  /** Set when a human rewrote this line. */
  editedAt?: string | null;
  /** Which stored version `script` currently holds. */
  version?: number;
  /** Every wording this line has had, newest first. */
  versions?: VoSegmentVersion[];
}

/** One stored wording of a line, with the take recorded from it (if any). */
export interface VoSegmentVersion {
  version: number;
  text: string;
  wordCount: number;
  source: 'generated' | 'edited';
  createdAt: string;
  audioUrl: string | null;
  voiceName: string | null;
}

/** Row in the script library. */
export interface VoScriptSummary {
  id: string;
  videoName: string;
  appName: string;
  tone: VoTone;
  provider: string;
  model: string;
  status: string;
  durationSec: number;
  segmentCount: number;
  totalWords: number;
  /** Set when this is another tone of an earlier run's frames. */
  sourceScriptId: string | null;
  /** How many other tones exist for the same frames. */
  variantCount: number;
  /** True when the stills are still stored, so a re-tone is possible. */
  canRegenerate: boolean;
  createdAt: string;
}

/** Distinct values present in storage, so filters only offer real options. */
export interface VoScriptFilters {
  tones: string[];
  providers: string[];
  statuses: string[];
}

/** A saved script with its segments — the durable form of a run's output. */
export interface VoScriptDetail extends VoScriptSummary {
  audience: string;
  /** The voice this script is narrated in; re-records follow it. */
  voiceId?: string | null;
  voiceName?: string | null;
  ttsModelId?: string | null;
  tone: VoTone;
  width: number;
  height: number;
  fps: number;
  wordsPerMinute: number;
  frameCount: number;
  error: string | null;
  segments: VoSegment[];
}

export interface VoJobSnapshot {
  id: string;
  phase: VoJobPhase;
  /** Durable record for this run — survives job expiry and restarts. */
  scriptId: string | null;
  config: {
    appName: string;
    audience: string;
    tone: VoTone;
    model: string;
    provider: string;
    videoName: string;
  };
  /** What this run actually used, for traceability after settings change. */
  settings: VoiceoverSettings;
  meta: VideoMeta | null;
  frames: Array<{ at: number; isSceneChange: boolean; imageUrl: string | null }>;
  segments: VoSegment[];
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; at: string }>;
  error: string | null;
  createdAt: string;
}

/** Events streamed over SSE from the voiceover job. */
/** ── Usage report ──────────────────────────────────────────────────────────
 * Raw provider units, never money: rates differ per account and change, so the
 * reader applies their own. `characters` is text-to-speech; tokens are vision.
 */
export interface VoUsageTotals {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  frames: number;
  characters: number;
}

export interface VoUsageBreakdown extends VoUsageTotals {
  key: string;
}

export interface VoUsageReport {
  days: number;
  since: string;
  totals: VoUsageTotals;
  byProvider: VoUsageBreakdown[];
  byModel: VoUsageBreakdown[];
  byKind: VoUsageBreakdown[];
  byDay: VoUsageBreakdown[];
  topScripts: Array<VoUsageBreakdown & { videoName: string | null; tone: string | null }>;
}

export type VoiceoverEvent =
  | { type: 'phase'; phase: VoJobPhase; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'meta'; meta: VideoMeta }
  | { type: 'frames'; count: number; sceneChanges: number }
  | { type: 'segment'; segment: VoSegment }
  | {
      type: 'done';
      scriptId: string | null;
      totalSegments: number;
      totalWords: number;
      spokenSec: number;
    }
  | { type: 'error'; message: string };
