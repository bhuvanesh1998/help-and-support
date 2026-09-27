/**
 * roles.routes.ts — CRUD for roles and their permission sets.
 *
 * Every endpoint needs `roles.manage`, which SUPER_ADMIN always has. The
 * catalogue is served alongside the roles so the UI never hardcodes a permission
 * list that could drift from the server's.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { PERMISSION_GROUPS } from '../../config/permissions.js';
import { requirePermission } from '../../middleware/permission.middleware.js';
import { createRole, deleteRole, listRoles, updateRole } from '../../services/roles.service.js';

export const rolesRouter: Router = Router();

rolesRouter.use(requirePermission('roles.manage'));

/** GET /api/admin/roles — roles plus the permission catalogue that defines them. */
rolesRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ roles: await listRoles(), groups: PERMISSION_GROUPS });
});

/** POST /api/admin/roles */
rolesRouter.post('/', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const role = await createRole({
    name: body['name'],
    description: body['description'],
    permissions: body['permissions'],
  });
  res.status(201).json({ role });
});

/** PATCH /api/admin/roles/:id */
rolesRouter.patch('/:id', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const role = await updateRole(String(req.params['id']), {
    ...('name' in body ? { name: body['name'] } : {}),
    ...('description' in body ? { description: body['description'] } : {}),
    ...('permissions' in body ? { permissions: body['permissions'] } : {}),
  });
  res.json({ role });
});

/** DELETE /api/admin/roles/:id — refused while any user still holds it. */
rolesRouter.delete('/:id', async (req: Request, res: Response) => {
  await deleteRole(String(req.params['id']));
  res.json({ deleted: true });
});
