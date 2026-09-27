/**
 * trash.routes.ts — List, restore and permanently delete trashed records.
 *
 * Restoring is gated by the permission of the thing being restored, not by a
 * blanket "trash" right: putting a page back is a page edit, and a role that
 * cannot touch pages must not be able to reach them through here.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { AppError } from '../../utils/app-error.js';
import { hasPermission } from '../../services/roles.service.js';
import {
  listTrash,
  permissionForType,
  purgeFromTrash,
  restoreFromTrash,
  sweepExpired,
} from '../../services/trash.service.js';

export const trashRouter: Router = Router();

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Does the caller hold the permission this type requires? */
async function assertAllowed(req: Request, type: string): Promise<void> {
  const permission = permissionForType(type);
  const caller = req.user!;
  if (!(await hasPermission(caller.id, caller.role, permission))) {
    throw AppError.forbidden(`Your role does not allow this (${permission} required).`);
  }
}

/** GET /api/admin/trash — everything the caller is allowed to see. */
trashRouter.get('/', async (req: Request, res: Response) => {
  const caller = req.user!;
  const result = await listTrash({
    can: (permission) => hasPermission(caller.id, caller.role, permission),
  });
  res.json(result);
});

/** POST /api/admin/trash/:type/:id/restore */
trashRouter.post('/:type/:id/restore', async (req: Request, res: Response) => {
  const type = p(req, 'type');
  await assertAllowed(req, type);
  await restoreFromTrash(type, p(req, 'id'));
  res.json({ restored: true });
});

/** DELETE /api/admin/trash/:type/:id — permanent, with its files. */
trashRouter.delete('/:type/:id', async (req: Request, res: Response) => {
  const type = p(req, 'type');
  await assertAllowed(req, type);
  await purgeFromTrash(type, p(req, 'id'));
  res.json({ deleted: true });
});

/**
 * POST /api/admin/trash/sweep — run the retention sweep now.
 * The list already sweeps opportunistically; this exists so the effect can be
 * triggered deliberately rather than only as a side effect of opening a screen.
 */
trashRouter.post('/sweep', async (_req: Request, res: Response) => {
  res.json({ purged: await sweepExpired() });
});
