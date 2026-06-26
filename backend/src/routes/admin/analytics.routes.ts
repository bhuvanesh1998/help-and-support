import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AnalyticsEventType } from '@prisma/client';
import { AppError } from '../../utils/app-error.js';

export const analyticsRouter: Router = Router();

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * GET /api/admin/analytics/summary
 * Returns aggregate stats for the last N days (default 30).
 */
analyticsRouter.get('/summary', async (req: Request, res: Response) => {
  const days = Math.min(90, Math.max(1, Number(req.query['days'] ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [totalEvents, byType, topRoutes, dailyViews] = await Promise.all([
    prisma.analyticsEvent.count({ where: { createdAt: { gte: since } } }),

    prisma.analyticsEvent.groupBy({
      by: ['eventType'],
      where: { createdAt: { gte: since } },
      _count: { eventType: true },
      orderBy: { _count: { eventType: 'desc' } },
    }),

    prisma.analyticsEvent.groupBy({
      by: ['routePath'],
      where: {
        eventType: AnalyticsEventType.PAGE_VIEW,
        createdAt: { gte: since },
        routePath: { not: null },
      },
      _count: { routePath: true },
      orderBy: { _count: { routePath: 'desc' } },
      take: 10,
    }),

    prisma.$queryRaw<Array<{ day: string; views: bigint }>>`
      SELECT
        DATE_TRUNC('day', "createdAt")::date::text AS day,
        COUNT(*) AS views
      FROM analytics_events
      WHERE "eventType" = 'PAGE_VIEW'
        AND "createdAt" >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC
    `,
  ]);

  res.json({
    period: { days, since },
    totalEvents,
    byType: byType.map((r) => ({ eventType: r.eventType, count: r._count.eventType })),
    topRoutes: topRoutes.map((r) => ({ routePath: r.routePath, views: r._count.routePath })),
    dailyViews: dailyViews.map((r) => ({ day: r.day, views: Number(r.views) })),
  });
});

/**
 * GET /api/admin/analytics/events?page=1&limit=50&eventType=PAGE_VIEW&routePath=/
 * Paginated recent events list.
 */
analyticsRouter.get('/events', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 50)));
  const skip = (page - 1) * limit;

  const validTypes = new Set(Object.values(AnalyticsEventType));
  const rawType = req.query['eventType'];
  const eventType =
    typeof rawType === 'string' && validTypes.has(rawType as AnalyticsEventType)
      ? (rawType as AnalyticsEventType)
      : undefined;

  const rawRoute = req.query['routePath'];
  const routePath = typeof rawRoute === 'string' && rawRoute ? rawRoute : undefined;

  const where = {
    ...(eventType && { eventType }),
    ...(routePath && { routePath }),
  };

  const [total, events] = await Promise.all([
    prisma.analyticsEvent.count({ where }),
    prisma.analyticsEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        eventType: true,
        routePath: true,
        sessionId: true,
        durationMs: true,
        country: true,
        createdAt: true,
      },
    }),
  ]);

  res.json({ data: events, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
});

void p; // suppress unused warning
