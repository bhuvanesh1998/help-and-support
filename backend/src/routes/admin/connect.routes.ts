/**
 * connect.routes.ts — Read/save the embeddable Help widget configuration.
 * Mounted under /api/admin/connect (JWT-protected).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWidgetConfig, saveWidgetConfig, sanitizeWidgetConfig } from '../../services/widget/config.js';

export const connectRouter: Router = Router();

/** GET /api/admin/connect — current saved widget config (or defaults). */
connectRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ config: await getWidgetConfig() });
});

/** PUT /api/admin/connect — validate + persist the widget config. */
connectRouter.put('/', async (req: Request, res: Response) => {
  const clean = sanitizeWidgetConfig((req.body ?? {}) as Record<string, unknown>);
  const saved = await saveWidgetConfig(clean);
  res.json({ config: saved });
});
