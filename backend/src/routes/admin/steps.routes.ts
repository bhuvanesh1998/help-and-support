import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';

/** Mounted at /api/admin/pages/:pageId/steps */
export const stepsRouter: Router = Router({ mergeParams: true });

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** GET /api/admin/pages/:pageId/steps */
stepsRouter.get('/', async (req: Request, res: Response) => {
  const pageId = p(req, 'pageId');
  const page = await prisma.page.findUnique({ where: { id: pageId } });
  if (!page) throw AppError.notFound('Page not found');

  const steps = await prisma.tutorialStep.findMany({
    where: { pageId },
    orderBy: { stepNumber: 'asc' },
  });
  res.json({ steps });
});

/** POST /api/admin/pages/:pageId/steps */
stepsRouter.post('/', async (req: Request, res: Response) => {
  const pageId = p(req, 'pageId');
  const page = await prisma.page.findUnique({ where: { id: pageId } });
  if (!page) throw AppError.notFound('Page not found');

  const body = req.body as {
    stepNumber?: unknown;
    title?: unknown;
    instructionsMd?: unknown;
    imageUrl?: unknown;
    mediaAssetId?: unknown;
  };

  if (typeof body.stepNumber !== 'number' || !Number.isInteger(body.stepNumber)) {
    throw AppError.badRequest('stepNumber must be an integer');
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    throw AppError.badRequest('title is required');
  }
  if (typeof body.instructionsMd !== 'string') {
    throw AppError.badRequest('instructionsMd is required');
  }

  const step = await prisma.tutorialStep.create({
    data: {
      pageId,
      stepNumber: body.stepNumber,
      title: body.title.trim(),
      instructionsMd: body.instructionsMd,
      imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : null,
      mediaAssetId: typeof body.mediaAssetId === 'string' ? body.mediaAssetId : null,
    },
  });

  res.status(201).json({ step });
});

/** GET /api/admin/pages/:pageId/steps/:stepId */
stepsRouter.get('/:stepId', async (req: Request, res: Response) => {
  const pageId = p(req, 'pageId');
  const stepId = p(req, 'stepId');
  const step = await prisma.tutorialStep.findFirst({
    where: { id: stepId, pageId },
  });
  if (!step) throw AppError.notFound('Step not found');
  res.json({ step });
});

/** PATCH /api/admin/pages/:pageId/steps/:stepId */
stepsRouter.patch('/:stepId', async (req: Request, res: Response) => {
  const pageId = p(req, 'pageId');
  const stepId = p(req, 'stepId');
  const existing = await prisma.tutorialStep.findFirst({ where: { id: stepId, pageId } });
  if (!existing) throw AppError.notFound('Step not found');

  const body = req.body as Record<string, unknown>;

  const updated = await prisma.tutorialStep.update({
    where: { id: stepId },
    data: {
      ...(typeof body['stepNumber'] === 'number' && { stepNumber: body['stepNumber'] }),
      ...(typeof body['title'] === 'string' && { title: body['title'].trim() }),
      ...(typeof body['instructionsMd'] === 'string' && {
        instructionsMd: body['instructionsMd'],
      }),
      ...(typeof body['imageUrl'] === 'string' && { imageUrl: body['imageUrl'] || null }),
      ...(typeof body['mediaAssetId'] === 'string' && {
        mediaAssetId: body['mediaAssetId'] || null,
      }),
    },
  });

  res.json({ step: updated });
});

/** DELETE /api/admin/pages/:pageId/steps/:stepId */
stepsRouter.delete('/:stepId', async (req: Request, res: Response) => {
  const pageId = p(req, 'pageId');
  const stepId = p(req, 'stepId');
  const existing = await prisma.tutorialStep.findFirst({ where: { id: stepId, pageId } });
  if (!existing) throw AppError.notFound('Step not found');

  await prisma.tutorialStep.delete({ where: { id: stepId } });
  res.status(204).send();
});

/**
 * POST /api/admin/pages/:pageId/steps/reorder
 * Body: { order: [{ id: string, stepNumber: number }] }
 */
stepsRouter.post('/reorder', async (req: Request, res: Response) => {
  const pageId = p(req, 'pageId');
  const page = await prisma.page.findUnique({ where: { id: pageId } });
  if (!page) throw AppError.notFound('Page not found');

  const body = req.body as { order?: unknown };
  if (!Array.isArray(body.order)) throw AppError.badRequest('order must be an array');

  const items = body.order as Array<{ id?: unknown; stepNumber?: unknown }>;
  for (const item of items) {
    if (typeof item.id !== 'string' || typeof item.stepNumber !== 'number') {
      throw AppError.badRequest('Each order item must have id (string) and stepNumber (number)');
    }
  }

  // Two-phase to respect the @@unique([pageId, stepNumber]) constraint: first
  // park every row in a high, collision-free range, then assign the final
  // numbers. A single-pass update would violate uniqueness on any swap.
  const OFFSET = 100_000;
  await prisma.$transaction([
    ...items.map((item) =>
      prisma.tutorialStep.updateMany({
        where: { id: item.id as string, pageId },
        data: { stepNumber: (item.stepNumber as number) + OFFSET },
      }),
    ),
    ...items.map((item) =>
      prisma.tutorialStep.updateMany({
        where: { id: item.id as string, pageId },
        data: { stepNumber: item.stepNumber as number },
      }),
    ),
  ]);

  const steps = await prisma.tutorialStep.findMany({
    where: { pageId },
    orderBy: { stepNumber: 'asc' },
  });

  res.json({ steps });
});
