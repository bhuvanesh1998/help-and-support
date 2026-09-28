/** Public branding values shown on the landing page. */
export interface SiteSettings {
  brandName: string;
  copyrightText: string;
  creditText: string;
  creditUrl: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
}

export interface SupportCategory {
  id: string;
  label: string;
  description?: string;
}

/** Public support configuration. */
export interface SupportConfig {
  enabled: boolean;
  widgetEnabled: boolean;
  slaText: string;
  intro: string;
  categories: SupportCategory[];
  priorities: string[];
}

export interface TicketInput {
  name: string;
  email: string;
  phone?: string;
  categoryId: string;
  priority?: string;
  subject: string;
  message: string;
  sourceUrl?: string;
  source: 'site' | 'widget';
  /** Honeypot — must stay empty. */
  website: string;
}

export interface TicketCreated {
  number: string | number;
  slaText: string;
}

export interface SearchResult {
  pageId: string;
  title: string;
  routePath: string;
  categoryName: string | null;
  snippet: string;
  matchedStep?: { id: string; stepNumber: number; title: string } | null;
}

// ── Admin ─────────────────────────────────────────────────────────────────
export interface AdminSupportConfig {
  enabled: boolean;
  slaText: string;
  intro: string;
  categories: SupportCategory[];
  priorities: string[];
  notifyEmail: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromName: string;
  fromEmail: string;
  hasPassword: boolean;
}

export type SmtpConfigInput = Omit<SmtpConfig, 'hasPassword'> & { password?: string };

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface TicketSummary {
  id: string;
  number: string | number;
  name: string;
  email: string;
  subject: string;
  categoryLabel: string;
  priority: string | null;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  replyCount: number;
}

export interface TicketReply {
  id: string;
  message: string;
  authorName: string | null;
  fromCustomer?: boolean;
  emailedAt: string | null;
  createdAt: string;
}

export interface TicketDetail extends TicketSummary {
  phone: string | null;
  message: string;
  sourceUrl: string | null;
  source: 'site' | 'widget';
  replies: TicketReply[];
}

export interface TicketListResponse {
  tickets: TicketSummary[];
  total: number;
  counts: Record<TicketStatus, number>;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  brandName: 'HelpAssistant',
  copyrightText: '© 2026 Widescreen Digital Solutions. All rights reserved.',
  creditText: 'Software Designed & Developed by widescreen.in',
  creditUrl: 'https://widescreen.in',
  logoLightUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
};

/** Requester-facing ticket view returned by the public tracker. */
export interface TrackedTicket {
  number: string;
  subject: string;
  categoryLabel: string;
  priority: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  message: string;
  createdAt: string;
  updatedAt: string;
  replies: { id: string; message: string; fromCustomer: boolean; authorName: string; createdAt: string }[];
}

/** A ticket this browser raised, remembered so the tracker can list it. */
export interface RememberedTicket {
  number: string;
  email: string;
  subject: string;
  createdAt: string;
}
