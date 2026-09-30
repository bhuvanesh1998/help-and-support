export interface TutorialStep {
  id: string;
  stepNumber: number;
  title: string;
  instructionsMd: string;
  imageUrl: string | null;
}

export interface ApiEndpoint {
  id: string;
  method: string;
  path: string;
  query: string | null;
  host: string | null;
  status: number | null;
  contentType: string | null;
  description: string | null;
}

/** A YouTube tutorial video. stepId null = feature overview; set = that step's walkthrough. */
export interface PageVideo {
  id: string;
  stepId: string | null;
  title: string;
  description: string | null;
  youtubeId: string;
  startSec: number;
}

export interface Page {
  id: string;
  routePath: string;
  slug: string | null;
  title: string;
  description: string | null;
  category?: string | null;
  categoryOrder?: number;
  /** ISO timestamp — present on the public list; powers the "New" badge/filter. */
  createdAt?: string;
  steps: TutorialStep[];
  /** Auto-captured API reference for this screen (present on the detail endpoint). */
  apiEndpoints?: ApiEndpoint[];
  /** Tutorial videos (present on the detail and by-route endpoints). */
  videos?: PageVideo[];
}

export interface PageResponse {
  page: Page;
}

export interface TutorialsResponse {
  tutorials: Array<Page & { _count: { steps: number; videos?: number } }>;
}

export interface TutorialDetailResponse {
  tutorial: Page;
}

export interface CategorySummary {
  name: string;
  order: number;
  icon: string | null;
  description: string | null;
  count: number;
}

export interface CategoriesResponse {
  categories: CategorySummary[];
}

export interface AnalyticsEventPayload {
  eventType: string;
  routePath?: string;
  pageId?: string;
  tutorialStepId?: string;
  sessionId?: string;
  anonymousId?: string;
  durationMs?: number;
  metadata?: unknown;
}
