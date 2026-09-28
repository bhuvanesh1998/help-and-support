/**
 * settings.ts — Single-row settings for site branding, the support desk and SMTP.
 * Each getter returns the saved row, creating it with defaults on first read.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { seal } from '../../lib/crypto.js';
import { AppError } from '../../utils/app-error.js';

const ROW = 'default';

// ── Site settings ──────────────────────────────────────────────────────────

export interface SiteSettingsData {
  brandName: string;
  copyrightText: string;
  creditText: string;
  creditUrl: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
}

function toSite(row: SiteSettingsData): SiteSettingsData {
  return {
    brandName: row.brandName,
    copyrightText: row.copyrightText,
    creditText: row.creditText,
    creditUrl: row.creditUrl,
    logoLightUrl: row.logoLightUrl,
    logoDarkUrl: row.logoDarkUrl,
  };
}

export async function getSiteSettings(): Promise<SiteSettingsData> {
  const row = await prisma.siteSettings.upsert({ where: { name: ROW }, create: { name: ROW }, update: {} });
  return toSite(row);
}

function str(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw AppError.badRequest(`${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw AppError.badRequest(`${field} must be a string`);
  const t = v.trim();
  if (required && !t) throw AppError.badRequest(`${field} is required`);
  if (t.length > max) throw AppError.badRequest(`${field} must be at most ${max} characters`);
  return t;
}

/** http(s) absolute URL or a site-relative /uploads/... path; empty → null. */
function url(v: unknown, field: string, allowRelative: boolean): string | null {
  const t = str(v, field, 2000);
  if (!t) return null;
  if (allowRelative && /^\/uploads\/[^\s]*$/.test(t)) return t;
  try {
    const u = new URL(t);
    if (u.protocol === 'http:' || u.protocol === 'https:') return t;
  } catch {
    /* fall through */
  }
  throw AppError.badRequest(`${field} must be an http(s) URL${allowRelative ? ' or an /uploads/ path' : ''}`);
}

export async function saveSiteSettings(input: Record<string, unknown>): Promise<SiteSettingsData> {
  const data: SiteSettingsData = {
    brandName: str(input['brandName'], 'brandName', 80, true),
    copyrightText: str(input['copyrightText'], 'copyrightText', 300),
    creditText: str(input['creditText'], 'creditText', 300),
    creditUrl: url(input['creditUrl'], 'creditUrl', false) ?? '',
    logoLightUrl: url(input['logoLightUrl'], 'logoLightUrl', true),
    logoDarkUrl: url(input['logoDarkUrl'], 'logoDarkUrl', true),
  };
  const row = await prisma.siteSettings.upsert({
    where: { name: ROW },
    create: { name: ROW, ...data },
    update: data,
  });
  return toSite(row);
}

// ── Support config ─────────────────────────────────────────────────────────

export interface SupportCategory {
  id: string;
  label: string;
  description?: string;
}

export interface SupportConfigData {
  enabled: boolean;
  slaText: string;
  intro: string;
  categories: SupportCategory[];
  priorities: string[];
  notifyEmail: string | null;
}

export const DEFAULT_CATEGORIES: SupportCategory[] = [
  { id: 'login', label: 'Login / Access', description: 'Trouble signing in, password resets or missing access.' },
  { id: 'bug', label: 'Bug / Error', description: 'Something is broken or shows an error.' },
  { id: 'billing', label: 'Billing', description: 'Invoices, payments and plan questions.' },
  { id: 'howto', label: 'How-to question', description: 'Not sure how to do something.' },
  { id: 'feature', label: 'Feature request', description: 'An idea for something new.' },
  { id: 'other', label: 'Other', description: 'Anything else.' },
];
export const DEFAULT_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
export const DEFAULT_INTRO =
  "Can't find the answer in the manual? Tell us what's wrong and our team will get back to you by email.";

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function parseCategories(v: unknown): SupportCategory[] {
  if (!Array.isArray(v)) return DEFAULT_CATEGORIES;
  const out: SupportCategory[] = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || typeof o['label'] !== 'string') continue;
    out.push({
      id: o['id'],
      label: o['label'],
      ...(typeof o['description'] === 'string' && o['description'] ? { description: o['description'] } : {}),
    });
  }
  return out.length ? out : DEFAULT_CATEGORIES;
}

function parsePriorities(v: unknown): string[] {
  if (!Array.isArray(v)) return DEFAULT_PRIORITIES;
  const out = v.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return out.length ? out : DEFAULT_PRIORITIES;
}

type SupportRow = {
  enabled: boolean;
  slaText: string;
  intro: string;
  categories: Prisma.JsonValue;
  priorities: Prisma.JsonValue;
  notifyEmail: string | null;
};

function toSupport(row: SupportRow): SupportConfigData {
  return {
    enabled: row.enabled,
    slaText: row.slaText,
    intro: row.intro,
    categories: parseCategories(row.categories),
    priorities: parsePriorities(row.priorities),
    notifyEmail: row.notifyEmail,
  };
}

export async function getSupportConfig(): Promise<SupportConfigData> {
  const row = await prisma.supportConfig.upsert({
    where: { name: ROW },
    create: {
      name: ROW,
      intro: DEFAULT_INTRO,
      categories: DEFAULT_CATEGORIES as unknown as Prisma.InputJsonValue,
      priorities: DEFAULT_PRIORITIES,
    },
    update: {},
  });
  return toSupport(row);
}

export async function saveSupportConfig(input: Record<string, unknown>): Promise<SupportConfigData> {
  const current = await getSupportConfig();

  let categories = current.categories;
  if (input['categories'] !== undefined) {
    if (!Array.isArray(input['categories'])) throw AppError.badRequest('categories must be an array');
    const seen = new Set<string>();
    categories = input['categories'].map((c, i) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const label = str(o['label'], `categories[${i}].label`, 80, true);
      const rawId = typeof o['id'] === 'string' && o['id'].trim() ? o['id'].trim() : label;
      const id = rawId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (!id) throw AppError.badRequest(`categories[${i}].id is invalid`);
      if (seen.has(id)) throw AppError.badRequest(`Duplicate category id: ${id}`);
      seen.add(id);
      const description = str(o['description'], `categories[${i}].description`, 300);
      return { id, label, ...(description ? { description } : {}) };
    });
    if (!categories.length) throw AppError.badRequest('At least one category is required');
    if (categories.length > 30) throw AppError.badRequest('At most 30 categories');
  }

  let priorities = current.priorities;
  if (input['priorities'] !== undefined) {
    if (!Array.isArray(input['priorities'])) throw AppError.badRequest('priorities must be an array');
    priorities = [...new Set(input['priorities'].map((p, i) => str(p, `priorities[${i}]`, 40, true)))];
    if (!priorities.length) throw AppError.badRequest('At least one priority is required');
    if (priorities.length > 10) throw AppError.badRequest('At most 10 priorities');
  }

  let notifyEmail = current.notifyEmail;
  if (input['notifyEmail'] !== undefined) {
    const e = str(input['notifyEmail'], 'notifyEmail', 254);
    if (e && !EMAIL_RE.test(e)) throw AppError.badRequest('notifyEmail is not a valid email address');
    notifyEmail = e || null;
  }

  const data = {
    enabled: typeof input['enabled'] === 'boolean' ? input['enabled'] : current.enabled,
    slaText: input['slaText'] !== undefined ? str(input['slaText'], 'slaText', 500) : current.slaText,
    intro: input['intro'] !== undefined ? str(input['intro'], 'intro', 2000) : current.intro,
    categories: categories as unknown as Prisma.InputJsonValue,
    priorities,
    notifyEmail,
  };
  const row = await prisma.supportConfig.update({ where: { name: ROW }, data });
  return toSupport(row);
}

// ── SMTP config ────────────────────────────────────────────────────────────

export interface SmtpPublic {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromName: string;
  fromEmail: string;
  hasPassword: boolean;
}

export async function getSmtpRow() {
  return prisma.smtpConfig.upsert({ where: { name: ROW }, create: { name: ROW }, update: {} });
}

export function toSmtpPublic(row: Awaited<ReturnType<typeof getSmtpRow>>): SmtpPublic {
  return {
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    hasPassword: !!row.passwordCiphertext,
  };
}

export async function getSmtpConfig(): Promise<SmtpPublic> {
  return toSmtpPublic(await getSmtpRow());
}

export async function saveSmtpConfig(input: Record<string, unknown>): Promise<SmtpPublic> {
  await getSmtpRow();
  const host = str(input['host'], 'host', 255);
  if (host && !/^[a-zA-Z0-9.-]+$/.test(host)) throw AppError.badRequest('host must be a hostname');
  const port = input['port'] === undefined ? 587 : Number(input['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw AppError.badRequest('port must be 1-65535');
  const fromEmail = str(input['fromEmail'], 'fromEmail', 254);
  if (fromEmail && !EMAIL_RE.test(fromEmail)) throw AppError.badRequest('fromEmail is not a valid email address');

  const data: Prisma.SmtpConfigUpdateInput = {
    host,
    port,
    secure: input['secure'] === true,
    username: str(input['username'], 'username', 255),
    fromName: str(input['fromName'], 'fromName', 120).replace(/[\r\n"]/g, ''),
    fromEmail,
  };

  // Password: absent/empty keeps the stored one, explicit null clears it.
  const pw = input['password'];
  if (pw === null) {
    data.passwordCiphertext = null;
    data.passwordIv = null;
    data.passwordAuthTag = null;
  } else if (typeof pw === 'string' && pw !== '') {
    if (pw.length > 1024) throw AppError.badRequest('password is too long');
    const s = seal(pw);
    data.passwordCiphertext = s.ciphertext;
    data.passwordIv = s.iv;
    data.passwordAuthTag = s.authTag;
  } else if (pw !== undefined && pw !== '') {
    throw AppError.badRequest('password must be a string');
  }

  const row = await prisma.smtpConfig.update({ where: { name: ROW }, data });
  return toSmtpPublic(row);
}
