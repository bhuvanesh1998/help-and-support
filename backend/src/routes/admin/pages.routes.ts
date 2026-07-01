import { Router } from 'express';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';

export const pagesRouter: Router = Router();

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** GET /api/admin/pages?page=1&limit=20 */
pagesRouter.get('/', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 20)));
  const skip = (page - 1) * limit;
  const category =
    typeof req.query['category'] === 'string' && req.query['category'].trim()
      ? req.query['category'].trim()
      : undefined;
  const where = category ? { category } : {};

  const [total, pages] = await Promise.all([
    prisma.page.count({ where }),
    prisma.page.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ categoryOrder: 'asc' }, { title: 'asc' }],
      include: { _count: { select: { steps: true } } },
    }),
  ]);

  res.json({ data: pages, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
});

/** POST /api/admin/pages */
pagesRouter.post('/', async (req: Request, res: Response) => {
  const body = req.body as {
    routePath?: unknown;
    title?: unknown;
    slug?: unknown;
    description?: unknown;
    category?: unknown;
    categoryOrder?: unknown;
    metaTitle?: unknown;
    metaDescription?: unknown;
    keywords?: unknown;
    canonicalUrl?: unknown;
    ogImageUrl?: unknown;
    noIndex?: unknown;
    isPublished?: unknown;
    structuredData?: unknown;
  };

  if (typeof body.routePath !== 'string' || !body.routePath.trim()) {
    throw AppError.badRequest('routePath is required');
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    throw AppError.badRequest('title is required');
  }

  const newPage = await prisma.page.create({
    data: {
      routePath: body.routePath.trim(),
      title: body.title.trim(),
      slug: typeof body.slug === 'string' ? body.slug.trim() || null : null,
      description: typeof body.description === 'string' ? body.description : null,
      category: typeof body.category === 'string' ? body.category.trim() || null : null,
      categoryOrder: typeof body.categoryOrder === 'number' ? body.categoryOrder : 99,
      metaTitle: typeof body.metaTitle === 'string' ? body.metaTitle : null,
      metaDescription: typeof body.metaDescription === 'string' ? body.metaDescription : null,
      keywords: Array.isArray(body.keywords)
        ? (body.keywords as string[]).filter((k) => typeof k === 'string')
        : [],
      canonicalUrl: typeof body.canonicalUrl === 'string' ? body.canonicalUrl : null,
      ogImageUrl: typeof body.ogImageUrl === 'string' ? body.ogImageUrl : null,
      noIndex: typeof body.noIndex === 'boolean' ? body.noIndex : false,
      isPublished: typeof body.isPublished === 'boolean' ? body.isPublished : true,
      structuredData:
        body.structuredData != null
          ? (body.structuredData as Prisma.InputJsonValue)
          : undefined,
    },
  });

  res.status(201).json({ page: newPage });
});

/** GET /api/admin/pages/:id */
pagesRouter.get('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const page = await prisma.page.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { stepNumber: 'asc' } },
      apiEndpoints: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
    },
  });
  if (!page) throw AppError.notFound('Page not found');
  res.json({ page });
});

/** PATCH /api/admin/pages/:id */
pagesRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const existing = await prisma.page.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Page not found');

  const body = req.body as Record<string, unknown>;

  const updated = await prisma.page.update({
    where: { id },
    data: {
      ...(typeof body['routePath'] === 'string' && { routePath: body['routePath'].trim() }),
      ...(typeof body['title'] === 'string' && { title: body['title'].trim() }),
      ...(typeof body['slug'] === 'string' && { slug: body['slug'].trim() || null }),
      ...(typeof body['description'] === 'string' && { description: body['description'] }),
      ...(typeof body['category'] === 'string' && { category: body['category'].trim() || null }),
      ...(typeof body['categoryOrder'] === 'number' && { categoryOrder: body['categoryOrder'] }),
      ...(typeof body['metaTitle'] === 'string' && { metaTitle: body['metaTitle'] }),
      ...(typeof body['metaDescription'] === 'string' && {
        metaDescription: body['metaDescription'],
      }),
      ...(Array.isArray(body['keywords']) && {
        keywords: (body['keywords'] as string[]).filter((k) => typeof k === 'string'),
      }),
      ...(typeof body['canonicalUrl'] === 'string' && { canonicalUrl: body['canonicalUrl'] }),
      ...(typeof body['ogImageUrl'] === 'string' && { ogImageUrl: body['ogImageUrl'] }),
      ...(typeof body['noIndex'] === 'boolean' && { noIndex: body['noIndex'] }),
      ...(typeof body['isPublished'] === 'boolean' && { isPublished: body['isPublished'] }),
      ...('structuredData' in body && {
        structuredData:
          body['structuredData'] === null
            ? Prisma.DbNull
            : (body['structuredData'] as Prisma.InputJsonValue),
      }),
    },
  });

  res.json({ page: updated });
});

/** DELETE /api/admin/pages/:id */
pagesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const existing = await prisma.page.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Page not found');

  await prisma.page.delete({ where: { id } });
  res.status(204).send();
});

// ── API endpoints (the auto-captured "API" tab; curatable here) ────────────────

/** POST /api/admin/pages/:id/api-endpoints — add an endpoint by hand. */
pagesRouter.post('/:id/api-endpoints', async (req: Request, res: Response) => {
  const pageId = p(req, 'id');
  const page = await prisma.page.findUnique({ where: { id: pageId } });
  if (!page) throw AppError.notFound('Page not found');

  const b = req.body as Record<string, unknown>;
  if (typeof b['method'] !== 'string' || !b['method'].trim()) throw AppError.badRequest('method is required');
  if (typeof b['path'] !== 'string' || !b['path'].trim()) throw AppError.badRequest('path is required');

  const max = await prisma.apiEndpoint.aggregate({ where: { pageId }, _max: { order: true } });
  const endpoint = await prisma.apiEndpoint.create({
    data: {
      pageId,
      method: b['method'].trim().toUpperCase().slice(0, 10),
      path: b['path'].trim(),
      query: typeof b['query'] === 'string' ? b['query'] : null,
      host: typeof b['host'] === 'string' ? b['host'] : null,
      requestBody: typeof b['requestBody'] === 'string' ? b['requestBody'] : null,
      status: typeof b['status'] === 'number' ? b['status'] : null,
      contentType: typeof b['contentType'] === 'string' ? b['contentType'] : null,
      responseSample: typeof b['responseSample'] === 'string' ? b['responseSample'] : null,
      description: typeof b['description'] === 'string' ? b['description'] : null,
      order: (max._max.order ?? -1) + 1,
    },
  });
  res.status(201).json({ endpoint });
});

/** PATCH /api/admin/pages/:id/api-endpoints/:endpointId — edit/curate one. */
pagesRouter.patch('/:id/api-endpoints/:endpointId', async (req: Request, res: Response) => {
  const pageId = p(req, 'id');
  const endpointId = p(req, 'endpointId');
  const existing = await prisma.apiEndpoint.findFirst({ where: { id: endpointId, pageId } });
  if (!existing) throw AppError.notFound('API endpoint not found');

  const b = req.body as Record<string, unknown>;
  const updated = await prisma.apiEndpoint.update({
    where: { id: endpointId },
    data: {
      ...(typeof b['method'] === 'string' && { method: b['method'].trim().toUpperCase().slice(0, 10) }),
      ...(typeof b['path'] === 'string' && { path: b['path'].trim() }),
      ...(typeof b['query'] === 'string' && { query: b['query'] || null }),
      ...(typeof b['host'] === 'string' && { host: b['host'] || null }),
      ...(typeof b['requestBody'] === 'string' && { requestBody: b['requestBody'] || null }),
      ...(typeof b['status'] === 'number' && { status: b['status'] }),
      ...(typeof b['contentType'] === 'string' && { contentType: b['contentType'] || null }),
      ...(typeof b['responseSample'] === 'string' && { responseSample: b['responseSample'] || null }),
      ...(typeof b['description'] === 'string' && { description: b['description'] || null }),
      ...(typeof b['order'] === 'number' && { order: b['order'] }),
    },
  });
  res.json({ endpoint: updated });
});

/** DELETE /api/admin/pages/:id/api-endpoints/:endpointId */
pagesRouter.delete('/:id/api-endpoints/:endpointId', async (req: Request, res: Response) => {
  const pageId = p(req, 'id');
  const endpointId = p(req, 'endpointId');
  const existing = await prisma.apiEndpoint.findFirst({ where: { id: endpointId, pageId } });
  if (!existing) throw AppError.notFound('API endpoint not found');

  await prisma.apiEndpoint.delete({ where: { id: endpointId } });
  res.status(204).send();
});
