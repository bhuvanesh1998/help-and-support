/**
 * categories.routes.ts — Manage help-center module categories.
 * Mounted under /api/admin/categories (JWT-protected).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';

export const categoriesRouter: Router = Router();

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Page counts grouped by category name. */
async function pageCounts(): Promise<Map<string, number>> {
  const rows = await prisma.page.groupBy({ by: ['category'], _count: { _all: true } });
  const m = new Map<string, number>();
  for (const r of rows) if (r.category) m.set(r.category, r._count._all);
  return m;
}

/** GET /api/admin/categories — list with page counts. */
categoriesRouter.get('/', async (_req: Request, res: Response) => {
  const [cats, counts] = await Promise.all([
    prisma.category.findMany({ orderBy: [{ order: 'asc' }, { name: 'asc' }] }),
    pageCounts(),
  ]);
  res.json({ data: cats.map((c) => ({ ...c, pageCount: counts.get(c.name) ?? 0 })) });
});

/** POST /api/admin/categories */
categoriesRouter.post('/', async (req: Request, res: Response) => {
  const b = req.body as { name?: unknown; order?: unknown; icon?: unknown; description?: unknown };
  if (typeof b.name !== 'string' || !b.name.trim()) throw AppError.badRequest('name is required');
  const created = await prisma.category.create({
    data: {
      name: b.name.trim(),
      order: typeof b.order === 'number' ? b.order : 99,
      icon: typeof b.icon === 'string' ? b.icon.trim() || null : null,
      description: typeof b.description === 'string' ? b.description : null,
    },
  });
  res.status(201).json({ category: created });
});

/** PATCH /api/admin/categories/:id — rename cascades to pages. */
categoriesRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Category not found');

  const b = req.body as { name?: unknown; order?: unknown; icon?: unknown; description?: unknown };
  const nextName = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : existing.name;

  const updated = await prisma.$transaction(async (tx) => {
    const cat = await tx.category.update({
      where: { id },
      data: {
        name: nextName,
        ...(typeof b.order === 'number' && { order: b.order }),
        ...(typeof b.icon === 'string' && { icon: b.icon.trim() || null }),
        ...(typeof b.description === 'string' && { description: b.description || null }),
      },
    });
    // Cascade a rename onto the pages that referenced the old name.
    if (nextName !== existing.name) {
      await tx.page.updateMany({ where: { category: existing.name }, data: { category: nextName } });
    }
    // Keep page.categoryOrder in sync with the category's order.
    if (typeof b.order === 'number') {
      await tx.page.updateMany({ where: { category: nextName }, data: { categoryOrder: b.order } });
    }
    return cat;
  });

  res.json({ category: updated });
});

/** DELETE /api/admin/categories/:id — unassigns pages (keeps the manuals). */
categoriesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = p(req, 'id');
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Category not found');
  await prisma.$transaction([
    prisma.page.updateMany({ where: { category: existing.name }, data: { category: null, categoryOrder: 99 } }),
    prisma.category.delete({ where: { id } }),
  ]);
  res.status(204).send();
});

/** POST /api/admin/categories/reorder — body { order: [{id, order}] }. */
categoriesRouter.post('/reorder', async (req: Request, res: Response) => {
  const items = (req.body as { order?: Array<{ id?: string; order?: number }> }).order;
  if (!Array.isArray(items)) throw AppError.badRequest('order array is required');
  await prisma.$transaction(
    items.flatMap((it) => {
      if (typeof it.id !== 'string' || typeof it.order !== 'number') return [];
      return [prisma.category.update({ where: { id: it.id }, data: { order: it.order } })];
    }),
  );
  // Re-sync page.categoryOrder from the new category orders.
  const cats = await prisma.category.findMany();
  await prisma.$transaction(
    cats.map((c) => prisma.page.updateMany({ where: { category: c.name }, data: { categoryOrder: c.order } })),
  );
  res.json({ ok: true });
});
