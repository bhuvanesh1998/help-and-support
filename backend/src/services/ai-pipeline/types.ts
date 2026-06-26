/**
 * AI Pipeline — shared types for the in-app scrape → draft → publish flow.
 */

export type JobPhase =
  | 'pending'
  | 'scraping'
  | 'drafting'
  | 'done'
  | 'error'
  | 'cancelled';

/** Public-facing job config (no secrets). */
export interface JobConfig {
  baseUrl: string;
  appName: string;
  email: string;
  navDepth: number;
  model: string;
  /** Run a visible browser and pause for manual captcha/login completion. */
  headed: boolean;
}

/**
 * A pre-authenticated session captured from a logged-in browser — lets the
 * scraper enter the app directly, skipping login + captcha entirely.
 * All fields are sensitive (treated like a password): in memory only.
 */
export interface SessionInjection {
  /** Session cookies (e.g. copied from DevTools → Application → Cookies). */
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>;
  /** localStorage entries the SPA reads its auth token from. */
  localStorage?: Record<string, string>;
  /** Where to land after injecting the session (default '/'). */
  startPath?: string;
}

/** Secrets held only in memory for the lifetime of the job. */
export interface JobSecrets {
  password: string;
  anthropicKey: string;
  session?: SessionInjection;
}

/** A real network API call observed while the screen was loading/active. */
export interface ApiCall {
  method: string; // GET, POST, PUT, PATCH, DELETE, WS, ...
  path: string; // pathname, e.g. /api/chat/active
  query: string | null; // raw query string (no leading '?')
  host: string | null; // host when cross-origin; null = same origin as the app
  requestBody: string | null; // truncated captured request payload
  status: number | null; // response status code
  contentType: string | null; // response content-type
  responseSample: string | null; // truncated response body sample
}

/** A single discovered screen. */
export interface CapturedScreen {
  id: string;
  name: string;
  group: string;
  url: string;
  /** Public URL of the screenshot once saved as a media asset (null if save failed). */
  imageUrl: string | null;
  /** Media asset id, if persisted. */
  mediaId: string | null;
  dom: ScreenDom;
  /** Real API calls the screen made (auto-captured network traffic). */
  apiCalls: ApiCall[];
  capturedAt: string;
  /** base64 PNG — kept in memory only, stripped before the snapshot is serialised. */
  base64?: string;
}

export interface ScreenDom {
  url: string;
  title: string;
  heading: string;
  inputs: Array<{ type: string; id: string; name: string; placeholder: string; label: string }>;
  buttons: Array<{ id: string; text: string; class: string }>;
  links: Array<{ text: string; href: string; class: string }>;
  navLinks: Array<{ text: string; href: string }>;
  bodyText: string;
}

export interface ScreenGroup {
  id: string;
  name: string;
  screenIds: string[];
  routePath: string;
}

export interface DraftStep {
  stepNumber: number;
  title: string;
  instructionsMd: string;
  screenshotId: string;
  imageUrl: string | null;
}

export interface DraftTutorial {
  groupId: string;
  groupName: string;
  page: { title: string; description: string; routePath: string };
  steps: DraftStep[];
}

/** Events streamed to the client over SSE. */
export type PipelineEvent =
  | { type: 'phase'; phase: JobPhase; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'screen'; screen: PublicScreen }
  | { type: 'group'; group: ScreenGroup }
  | { type: 'draft'; tutorial: DraftTutorial }
  | { type: 'done'; totalScreens: number; totalTutorials: number }
  | { type: 'error'; message: string };

/** Screen shape sent to the client (no base64 blob). */
export type PublicScreen = Omit<CapturedScreen, 'base64' | 'dom'> & {
  dom: Pick<ScreenDom, 'heading' | 'title'>;
};

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}
