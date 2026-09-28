/**
 * support.routes.ts — Admin: site branding, support form config, SMTP, tickets.
 * All routers are mounted after `authenticate`, each behind its own feature guard.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';
import {
  EMAIL_RE,
  getSiteSettings,
  getSmtpConfig,
  getSupportConfig,
  saveSiteSettings,
  saveSmtpConfig,
  saveSupportConfig,
} from '../../services/support/settings.js';
import {
  formatTicketNumber,
  sendMail,
  testEmail,
  ticketReplyEmail,
  trySendMail,
} from '../../services/mail/mailer.js';

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
type Status = (typeof STATUSES)[number];
const isStatus = (v: unknown): v is Status => typeof v === 'string' && (STATUSES as readonly string[]).includes(v);

// ── /api/admin/site-settings (settings) ──────────────────────────────────────
export const siteSettingsRouter: Router = Router();

siteSettingsRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ settings: await getSiteSettings() });
});

siteSettingsRouter.put('/', async (req: Request, res: Response) => {
  res.json({ settings: await saveSiteSettings((req.body ?? {}) as Record<string, unknown>) });
});

// ── /api/admin/support/smtp (settings) ───────────────────────────────────────
export const smtpRouter: Router = Router();

smtpRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ config: await getSmtpConfig() });
});

smtpRouter.put('/', async (req: Request, res: Response) => {
  res.json({ config: await saveSmtpConfig((req.body ?? {}) as Record<string, unknown>) });
});

smtpRouter.post('/test', async (req: Request, res: Response) => {
  const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
  if (!EMAIL_RE.test(to)) throw AppError.badRequest('Enter a valid recipient address');
  try {
    await sendMail(await testEmail(to));
  } catch (err) {
    throw AppError.badRequest(err instanceof Error ? err.message : 'Sending failed');
  }
  res.json({ ok: true });
});

// ── /api/admin/support (support) ─────────────────────────────────────────────
export const supportRouter: Router = Router();

supportRouter.get('/config', async (_req: Request, res: Response) => {
  res.json({ config: await getSupportConfig() });
});

supportRouter.put('/config', async (req: Request, res: Response) => {
  res.json({ config: await saveSupportConfig((req.body ?? {}) as Record<string, unknown>) });
});

type TicketRow = Prisma.TicketGetPayload<object>;

function present(t: TicketRow) {
  return { ...t, number: formatTicketNumber(t.number), numberRaw: t.number };
}

supportRouter.get('/tickets', async (req: Request, res: Response) => {
  const status = req.query['status'];
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim().slice(0, 100) : '';
  const page = Math.max(1, Math.floor(Number(req.query['page']) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query['pageSize']) || 20)));

  const search: Prisma.TicketWhereInput = {};
  if (q) {
    const c = { contains: q, mode: 'insensitive' as const };
    const or: Prisma.TicketWhereInput[] = [{ subject: c }, { name: c }, { email: c }, { message: c }];
    const num = /^(?:ha-)?0*(\d{1,9})$/i.exec(q);
    if (num) or.push({ number: Number(num[1]) });
    search.OR = or;
  }
  const where: Prisma.TicketWhereInput = isStatus(status) ? { ...search, status } : search;

  const [rows, total, grouped] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { replies: true } } },
    }),
    prisma.ticket.count({ where }),
    prisma.ticket.groupBy({ by: ['status'], where: search, _count: { _all: true } }),
  ]);

  const counts: Record<Status, number> = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
  for (const g of grouped) if (isStatus(g.status)) counts[g.status] = g._count._all;

  res.json({
    tickets: rows.map(({ _count, message, ...t }) => ({
      ...present({ ...t, message } as TicketRow),
      message: message.length > 240 ? message.slice(0, 240) + '…' : message,
      replyCount: _count.replies,
    })),
    total,
    counts,
  });
});

async function loadTicket(id: string) {
  const t = await prisma.ticket.findUnique({
    where: { id },
    include: { replies: { orderBy: { createdAt: 'asc' } } },
  });
  if (!t) throw AppError.notFound('Ticket not found');
  return t;
}

function presentFull(t: Awaited<ReturnType<typeof loadTicket>>) {
  const { replies, ...rest } = t;
  return { ...present(rest), replies, replyCount: replies.length };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ticketId(req: Request): string {
  const id = String(req.params['id'] ?? '');
  if (!UUID_RE.test(id)) throw AppError.notFound('Ticket not found');
  return id;
}

supportRouter.get('/tickets/:id', async (req: Request, res: Response) => {
  res.json({ ticket: presentFull(await loadTicket(ticketId(req))) });
});

supportRouter.post('/tickets/:id/replies', async (req: Request, res: Response) => {
  const id = ticketId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body['message'] === 'string' ? body['message'].trim() : '';
  if (message.length < 1) throw AppError.badRequest('Reply message is required');
  if (message.length > 10000) throw AppError.badRequest('Reply must be at most 10000 characters');
  if (body['status'] !== undefined && !isStatus(body['status'])) {
    throw AppError.badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  }
  const status = isStatus(body['status']) ? body['status'] : undefined;

  const existing = await loadTicket(id);
  const reply = await prisma.ticketReply.create({
    data: {
      ticketId: id,
      message,
      authorId: req.user?.id ?? null,
      authorName: req.user?.email ?? 'Support',
    },
  });
  const updated = await prisma.ticket.update({
    where: { id },
    data: status ? { status } : { updatedAt: new Date() },
  });

  const emailed = await trySendMail(await ticketReplyEmail({ ...existing, ...updated }, message), 'ticket-reply');
  const savedReply = emailed
    ? await prisma.ticketReply.update({ where: { id: reply.id }, data: { emailedAt: new Date() } })
    : reply;

  res.status(201).json({
    reply: savedReply,
    ticket: presentFull(await loadTicket(id)),
    emailed,
  });
});

supportRouter.patch('/tickets/:id', async (req: Request, res: Response) => {
  const id = ticketId(req);
  const status = (req.body ?? {})['status'];
  if (!isStatus(status)) throw AppError.badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  await loadTicket(id);
  await prisma.ticket.update({ where: { id }, data: { status } });
  res.json({ ticket: presentFull(await loadTicket(id)) });
});
