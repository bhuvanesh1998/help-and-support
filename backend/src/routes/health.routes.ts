import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export const healthRouter: Router = Router();

/** Liveness: process is up. */
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

/** Readiness: process is up AND the database answers. */
healthRouter.get('/health/ready', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', database: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'down' });
  }
});
