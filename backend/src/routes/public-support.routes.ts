/**
 * public-support.routes.ts — Unauthenticated branding, support form, and search.
 * Mounted under /api/public (after publicLimiter).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../utils/app-error.js';
import { ticketLimiter } from '../middleware/rate-limit.js';
import { EMAIL_RE, getSiteSettings, getSupportConfig } from '../services/support/settings.js';
import { getWidgetConfig } from '../services/widget/config.js';
import {
  formatTicketNumber,
  ticketAckEmail,
  ticketNotifyEmail,
  trySendMail,
} from '../services/mail/mailer.js';

export const publicSupportRouter: Router = Router();

/** GET /api/public/site-settings */
publicSupportRouter.get('/site-settings', async (_req: Request, res: Response) => {
  res.json({ settings: await getSiteSettings() });
});

/** GET /api/public/support/config */
publicSupportRouter.get('/support/config', async (_req: Request, res: Response) => {
  const [cfg, widget] = await Promise.all([getSupportConfig(), getWidgetConfig()]);
  res.json({
    config: {
      enabled: cfg.enabled,
      widgetEnabled: widget.supportEnabled,
      slaText: cfg.slaText,
      intro: cfg.intro,
      categories: cfg.categories,
      priorities: cfg.priorities,
    },
  });
});

function field(body: Record<string, unknown>, key: string, min: number, max: number, label: string): string {
  const v = body[key];
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length < min) {
    throw AppError.badRequest(min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters`);
  }
  if (t.length > max) throw AppError.badRequest(`${label} must be at most ${max} characters`);
  return t;
}

function optional(body: Record<string, unknown>, key: string, max: number): string | null {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim().slice(0, max);
}

/** POST /api/public/support/tickets */
publicSupportRouter.post('/support/tickets', ticketLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cfg = await getSupportConfig();

  // Honeypot: bots fill every field. Pretend success, store nothing.
  if (typeof body['website'] === 'string' && body['website'].trim() !== '') {
    logger.warn('support honeypot triggered', { ip: req.ip });
    res.status(201).json({ ticket: { number: formatTicketNumber(0), slaText: cfg.slaText } });
    return;
  }

  if (!cfg.enabled) {
    throw new AppError(403, 'Support requests are currently disabled.', { code: 'SUPPORT_DISABLED' });
  }

  const name = field(body, 'name', 1, 120, 'Name');
  const email = field(body, 'email', 3, 254, 'Email').toLowerCase();
  if (!EMAIL_RE.test(email)) throw AppError.badRequest('Email is not a valid email address');
  const phone = optional(body, 'phone', 40);
  if (phone && !/^[0-9+()\-.\s]{4,40}$/.test(phone)) throw AppError.badRequest('Phone number is invalid');
  // Subject goes into a mail header — no line breaks.
  const subject = field(body, 'subject', 3, 200, 'Subject').replace(/[\r\n]+/g, ' ');
  const message = field(body, 'message', 10, 5000, 'Message');

  const categoryId = typeof body['categoryId'] === 'string' ? body['categoryId'] : '';
  const category = cfg.categories.find((c) => c.id === categoryId);
  if (!category) throw AppError.badRequest('Choose a valid category');

  const rawPriority = typeof body['priority'] === 'string' ? body['priority'] : '';
  const priority = cfg.priorities.includes(rawPriority)
    ? rawPriority
    : cfg.priorities.includes('Normal')
      ? 'Normal'
      : cfg.priorities[0]!;

  let sourceUrl = optional(body, 'sourceUrl', 2000);
  if (sourceUrl && !/^(https?:\/\/|\/)/i.test(sourceUrl)) sourceUrl = null;
  const source = body['source'] === 'widget' ? 'widget' : 'site';

  const ticket = await prisma.ticket.create({
    data: {
      name,
      email,
      phone,
      categoryId: category.id,
      categoryLabel: category.label,
      priority,
      subject,
      message,
      sourceUrl,
      source,
    },
  });

  // Best effort: emails never fail the request.
  void (async () => {
    const ok = await trySendMail(await ticketAckEmail(ticket, cfg.slaText), 'ticket-ack');
    if (ok) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: { ackSentAt: new Date() } });
    }
    if (cfg.notifyEmail) {
      await trySendMail(await ticketNotifyEmail(ticket, cfg.notifyEmail), 'ticket-notify');
    }
  })().catch((err: unknown) => {
    logger.error('ticket email pipeline failed', {
      ticketId: ticket.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  res.status(201).json({ ticket: { number: formatTicketNumber(ticket.number), slaText: cfg.slaText } });
});

/**
 * GET /api/public/search?q=&limit=
 * Case-insensitive search over published pages (title, description, route,
 * category) and their steps (title, instructions). Title matches rank first.
 */
publicSupportRouter.get('/search', async (req: Request, res: Response) => {
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim().slice(0, 100) : '';
  if (q.length < 2) {
    res.json({ results: [] });
    return;
  }
  const rawLimit = Number(req.query['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 20) : 10;

  const c = { contains: q, mode: 'insensitive' as const };
  const stepMatch: Prisma.TutorialStepWhereInput = { OR: [{ title: c }, { instructionsMd: c }] };

  const pages = await prisma.page.findMany({
    where: {
      isPublished: true,
      OR: [
        { title: c },
        { description: c },
        { routePath: c },
        { category: c },
        { steps: { some: stepMatch } },
      ],
    },
    select: {
      id: true,
      title: true,
      description: true,
      routePath: true,
      category: true,
      steps: {
        where: stepMatch,
        orderBy: { stepNumber: 'asc' },
        take: 1,
        select: { id: true, stepNumber: true, title: true, instructionsMd: true },
      },
    },
    take: 100,
  });

  const needle = q.toLowerCase();
  const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(needle);

  const scored = pages.map((p) => {
    const step = p.steps[0];
    let score = 5;
    if (p.title.toLowerCase().startsWith(needle)) score = 0;
    else if (has(p.title)) score = 1;
    else if (step && has(step.title)) score = 2;
    else if (has(p.description) || has(p.category)) score = 3;
    else if (has(p.routePath)) score = 4;

    let snippet = '';
    const source =
      step && (has(step.instructionsMd) || has(step.title))
        ? plain(step.instructionsMd)
        : plain(p.description ?? '');
    snippet = makeSnippet(source || plain(step?.instructionsMd ?? ''), needle);

    return {
      score,
      result: {
        pageId: p.id,
        title: p.title,
        routePath: p.routePath,
        categoryName: p.category,
        snippet,
        ...(step ? { matchedStep: { id: step.id, stepNumber: step.stepNumber, title: step.title } } : {}),
      },
    };
  });

  scored.sort((a, b) => a.score - b.score || a.result.title.localeCompare(b.result.title));
  res.json({ results: scored.slice(0, limit).map((s) => s.result) });
});

/** Rough markdown → text for snippets. */
function plain(md: string): string {
  return md
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeSnippet(text: string, needle: string, radius = 70): string {
  if (!text) return '';
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return text.length > radius * 2 ? text.slice(0, radius * 2).trimEnd() + '…' : text;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + needle.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}
