/**
 * users.routes.ts — Admin accounts and the role each one holds.
 *
 * Two separate ideas live here and must not be conflated:
 *   • `role` (UserRole) is the account tier. Only a SUPER_ADMIN may grant it,
 *     because it bypasses every permission check.
 *   • `roleId` points at a Role, which decides what features the account can
 *     reach. Anyone with `users.manage` may assign one.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';
import { requirePermission } from '../../middleware/permission.middleware.js';
import { hasPermission } from '../../services/roles.service.js';

export const usersRouter: Router = Router();

/** Shared shape: the account plus the name of the role it holds. */
const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  roleId: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  accessRole: { select: { name: true } },
} as const;

interface UserRow {
  accessRole?: { name: string } | null;
}

/** Flatten the joined role to a plain `roleName` for the client. */
function shape<T extends UserRow>(user: T): Omit<T, 'accessRole'> & { roleName: string | null } {
  const { accessRole, ...rest } = user;
  return { ...rest, roleName: accessRole?.name ?? null };
}

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Validate an incoming roleId. `null` clears the assignment. */
async function resolveRoleId(value: unknown): Promise<string | null> {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw AppError.badRequest('roleId must be a string or null');

  const role = await prisma.role.findUnique({ where: { id: value }, select: { id: true } });
  if (!role) throw AppError.badRequest('That role no longer exists');
  return role.id;
}

/** GET /api/admin/users */
usersRouter.get('/', requirePermission('users.manage'), async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    select: USER_SELECT,
    orderBy: { createdAt: 'desc' },
  });
  res.json({ users: users.map(shape) });
});

/** POST /api/admin/users */
usersRouter.post('/', requirePermission('users.manage'), async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  if (typeof body['email'] !== 'string' || !body['email'].trim()) {
    throw AppError.badRequest('email is required');
  }
  if (typeof body['password'] !== 'string' || body['password'].length < 8) {
    throw AppError.badRequest('password must be at least 8 characters');
  }

  // Only a SUPER_ADMIN can mint another one: the tier ignores permissions
  // entirely, so granting it from a delegated role would be an escalation.
  const wantsSuper = body['role'] === UserRole.SUPER_ADMIN;
  if (wantsSuper && req.user!.role !== UserRole.SUPER_ADMIN) {
    throw AppError.forbidden('Only a super admin can create another super admin');
  }

  const user = await prisma.user.create({
    data: {
      email: body['email'].toLowerCase().trim(),
      passwordHash: await bcrypt.hash(body['password'], 12),
      role: wantsSuper ? UserRole.SUPER_ADMIN : UserRole.ADMIN,
      roleId: await resolveRoleId(body['roleId'] ?? null),
    },
    select: USER_SELECT,
  });

  res.status(201).json({ user: shape(user) });
});

/**
 * PATCH /api/admin/users/:id
 * Anyone may change their own email and password. Everything that widens access
 * — the tier, the assigned role, reactivation — needs the matching authority.
 */
usersRouter.patch('/:id', async (req: Request, res: Response) => {
  const targetId = p(req, 'id');
  const caller = req.user!;
  const isSuper = caller.role === UserRole.SUPER_ADMIN;
  const mayManage = await hasPermission(caller.id, caller.role, 'users.manage');

  if (!mayManage && caller.id !== targetId) {
    throw AppError.forbidden('You can only update your own account');
  }

  const existing = await prisma.user.findUnique({ where: { id: targetId } });
  if (!existing) throw AppError.notFound('User not found');

  const body = req.body as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  if (typeof body['password'] === 'string' && body['password'].length >= 8) {
    data['passwordHash'] = await bcrypt.hash(body['password'], 12);
    // The old password's sessions must not survive it — that is the whole point
    // of changing it after a suspected compromise.
    data['tokenVersion'] = { increment: 1 };
  }
  if (typeof body['email'] === 'string') {
    data['email'] = body['email'].toLowerCase().trim();
  }
  if (mayManage && typeof body['isActive'] === 'boolean') {
    data['isActive'] = body['isActive'];
  }
  // Self-assignment of a role would let any account grant itself Administrator,
  // so this needs users.manage even on your own record.
  if ('roleId' in body) {
    if (!mayManage) throw AppError.forbidden('You cannot change your own role');
    data['roleId'] = await resolveRoleId(body['roleId']);
  }
  if (isSuper && (body['role'] === UserRole.ADMIN || body['role'] === UserRole.SUPER_ADMIN)) {
    data['role'] = body['role'];
  }

  if (Object.keys(data).length === 0) throw AppError.badRequest('No updatable fields provided');

  const updated = await prisma.user.update({
    where: { id: targetId },
    data,
    select: USER_SELECT,
  });

  res.json({ user: shape(updated) });
});

/** DELETE /api/admin/users/:id — soft-delete (deactivate). */
usersRouter.delete(
  '/:id',
  requirePermission('users.manage'),
  async (req: Request, res: Response) => {
    const targetId = p(req, 'id');

    if (targetId === req.user!.id) {
      throw AppError.badRequest('You cannot deactivate your own account');
    }

    const existing = await prisma.user.findUnique({ where: { id: targetId } });
    if (!existing) throw AppError.notFound('User not found');

    // A delegated user manager must not be able to switch off a super admin.
    if (existing.role === UserRole.SUPER_ADMIN && req.user!.role !== UserRole.SUPER_ADMIN) {
      throw AppError.forbidden('Only a super admin can deactivate another super admin');
    }

    await prisma.user.update({ where: { id: targetId }, data: { isActive: false } });
    res.status(204).send();
  },
);
