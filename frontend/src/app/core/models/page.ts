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
  requestBody: string | null;
  status: number | null;
  contentType: string | null;
  responseSample: string | null;
  description: string | null;
}

export interface Page {
  id: string;
  routePath: string;
  slug: string | null;
  title: string;
  description: string | null;
  category?: string | null;
  categoryOrder?: number;
  steps: TutorialStep[];
  /** Auto-captured API reference for this screen (present on the detail endpoint). */
  apiEndpoints?: ApiEndpoint[];
}

export interface PageResponse {
  page: Page;
}

export interface TutorialsResponse {
  tutorials: Array<Page & { _count: { steps: number } }>;
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
