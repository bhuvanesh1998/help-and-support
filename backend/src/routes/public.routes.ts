import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash, createHmac } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { AnalyticsEventType } from '@prisma/client';

export const publicRouter: Router = Router();

/**
 * GET /api/public/tutorials
 * Returns all published pages with their ordered steps — used by the landing page.
 */
publicRouter.get('/tutorials', async (_req: Request, res: Response) => {
  const pages = await prisma.page.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        select: {
          id: true,
          stepNumber: true,
          title: true,
          instructionsMd: true,
          imageUrl: true,
        },
      },
      _count: { select: { steps: true } },
    },
  });
  res.json({ tutorials: pages });
});

/**
 * GET /api/public/tutorials/:id
 * Returns a single tutorial page with all steps.
 */
publicRouter.get('/tutorials/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const page = await prisma.page.findUnique({
    where: { id },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        select: {
          id: true,
          stepNumber: true,
          title: true,
          instructionsMd: true,
          imageUrl: true,
        },
      },
      apiEndpoints: {
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          method: true,
          path: true,
          query: true,
          host: true,
          requestBody: true,
          status: true,
          contentType: true,
          responseSample: true,
          description: true,
        },
      },
    },
  });
  if (!page) throw AppError.notFound(`User manual not found: ${id}`);
  res.json({ tutorial: page });
});

/**
 * GET /api/public/categories
 * Module categories (ordered) with the count of published manuals in each —
 * powers the landing-page summary cards.
 */
publicRouter.get('/categories', async (_req: Request, res: Response) => {
  const [cats, grouped] = await Promise.all([
    prisma.category.findMany({ orderBy: [{ order: 'asc' }, { name: 'asc' }] }),
    prisma.page.groupBy({ by: ['category'], _count: { _all: true } }),
  ]);
  const counts = new Map<string, number>();
  for (const g of grouped) if (g.category) counts.set(g.category, g._count._all);

  // Include any page categories that don't have a Category row yet (fallback).
  const known = new Set(cats.map((c) => c.name));
  const extras = [...counts.keys()]
    .filter((n) => !known.has(n))
    .map((name) => ({ name, order: 99, icon: null as string | null, description: null as string | null }));

  const data = [...cats, ...extras]
    .map((c) => ({ name: c.name, order: c.order, icon: c.icon, description: c.description, count: counts.get(c.name) ?? 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  res.json({ categories: data });
});

/**
 * GET /api/public/pages?routePath=/some/path
 * Returns the page record and its ordered tutorial steps.
 */
publicRouter.get('/pages', async (req: Request, res: Response) => {
  const { routePath } = req.query;
  if (typeof routePath !== 'string' || !routePath.trim()) {
    throw AppError.badRequest('routePath query parameter is required');
  }

  const page = await prisma.page.findUnique({
    where: { routePath: routePath.trim() },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        select: {
          id: true,
          stepNumber: true,
          title: true,
          instructionsMd: true,
          imageUrl: true,
        },
      },
    },
  });

  if (!page) throw AppError.notFound(`No help content for route: ${routePath}`);

  // Fire PAGE_VIEW analytics in background — don't await, never block the response.
  void recordEvent({
    eventType: AnalyticsEventType.PAGE_VIEW,
    routePath: routePath.trim(),
    pageId: page.id,
    req,
  });

  res.json({ page });
});

/**
 * POST /api/public/events
 * Client-side analytics ingestion. Fire-and-forget by design; errors are logged not surfaced.
 */
publicRouter.post('/events', async (req: Request, res: Response) => {
  const body = req.body as {
    eventType?: string;
    routePath?: string;
    pageId?: string;
    tutorialStepId?: string;
    sessionId?: string;
    anonymousId?: string;
    durationMs?: number;
    metadata?: unknown;
  };

  const validTypes = new Set(Object.values(AnalyticsEventType));
  if (!body.eventType || !validTypes.has(body.eventType as AnalyticsEventType)) {
    throw AppError.badRequest(`eventType must be one of: ${[...validTypes].join(', ')}`);
  }

  await recordEvent({
    eventType: body.eventType as AnalyticsEventType,
    routePath: body.routePath,
    pageId: body.pageId,
    tutorialStepId: body.tutorialStepId,
    sessionId: body.sessionId,
    anonymousId: body.anonymousId,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
    metadata: body.metadata,
    req,
  });

  res.status(202).json({ accepted: true });
});

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

interface EventInput {
  eventType: AnalyticsEventType;
  routePath?: string;
  pageId?: string;
  tutorialStepId?: string;
  sessionId?: string;
  anonymousId?: string;
  durationMs?: number;
  metadata?: unknown;
  req: Request;
}

async function recordEvent(input: EventInput): Promise<void> {
  const ip = input.req.ip ?? '';
  const ipHash = ip
    ? createHmac('sha256', env.jwtSecret).update(ip).digest('hex')
    : undefined;

  const ua = input.req.headers['user-agent'];
  const referrer = input.req.headers.referer ?? input.req.headers.referrer;

  await prisma.analyticsEvent.create({
    data: {
      eventType: input.eventType,
      routePath: input.routePath,
      pageId: input.pageId,
      tutorialStepId: input.tutorialStepId,
      sessionId: input.sessionId,
      anonymousId: input.anonymousId,
      durationMs: input.durationMs,
      metadata: input.metadata ?? undefined,
      userAgent: typeof ua === 'string' ? ua : undefined,
      referrer: typeof referrer === 'string' ? referrer : undefined,
      ipHash,
    },
  });
}

// suppress unused import warning — createHash is exported for use in media routes
void createHash;
