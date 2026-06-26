import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app-error.js';
import { requireRole } from '../../middleware/auth.middleware.js';

export const usersRouter: Router = Router();

function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** GET /api/admin/users — SUPER_ADMIN only */
usersRouter.get('/', requireRole(UserRole.SUPER_ADMIN), async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ users });
});

/** POST /api/admin/users — SUPER_ADMIN only */
usersRouter.post('/', requireRole(UserRole.SUPER_ADMIN), async (req: Request, res: Response) => {
  const body = req.body as {
    email?: unknown;
    password?: unknown;
    role?: unknown;
  };

  if (typeof body.email !== 'string' || !body.email.trim()) {
    throw AppError.badRequest('email is required');
  }
  if (typeof body.password !== 'string' || body.password.length < 8) {
    throw AppError.badRequest('password must be at least 8 characters');
  }

  const role = body.role === UserRole.SUPER_ADMIN ? UserRole.SUPER_ADMIN : UserRole.ADMIN;
  const passwordHash = await bcrypt.hash(body.password, 12);

  const user = await prisma.user.create({
    data: {
      email: body.email.toLowerCase().trim(),
      passwordHash,
      role,
    },
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  });

  res.status(201).json({ user });
});

/** PATCH /api/admin/users/:id — SUPER_ADMIN can edit any; ADMIN can only edit own */
usersRouter.patch('/:id', async (req: Request, res: Response) => {
  const targetId = p(req, 'id');
  const caller = req.user!;

  if (caller.role !== UserRole.SUPER_ADMIN && caller.id !== targetId) {
    throw AppError.forbidden('You can only update your own account');
  }

  const existing = await prisma.user.findUnique({ where: { id: targetId } });
  if (!existing) throw AppError.notFound('User not found');

  const body = req.body as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  if (typeof body['password'] === 'string' && body['password'].length >= 8) {
    data['passwordHash'] = await bcrypt.hash(body['password'], 12);
  }
  if (typeof body['email'] === 'string') {
    data['email'] = body['email'].toLowerCase().trim();
  }
  if (caller.role === UserRole.SUPER_ADMIN && typeof body['isActive'] === 'boolean') {
    data['isActive'] = body['isActive'];
  }
  if (
    caller.role === UserRole.SUPER_ADMIN &&
    (body['role'] === UserRole.ADMIN || body['role'] === UserRole.SUPER_ADMIN)
  ) {
    data['role'] = body['role'];
  }

  if (Object.keys(data).length === 0) throw AppError.badRequest('No updatable fields provided');

  const updated = await prisma.user.update({
    where: { id: targetId },
    data,
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      updatedAt: true,
    },
  });

  res.json({ user: updated });
});

/** DELETE /api/admin/users/:id — soft-delete (deactivate), SUPER_ADMIN only */
usersRouter.delete(
  '/:id',
  requireRole(UserRole.SUPER_ADMIN),
  async (req: Request, res: Response) => {
    const targetId = p(req, 'id');

    if (targetId === req.user!.id) {
      throw AppError.badRequest('You cannot deactivate your own account');
    }

    const existing = await prisma.user.findUnique({ where: { id: targetId } });
    if (!existing) throw AppError.notFound('User not found');

    await prisma.user.update({ where: { id: targetId }, data: { isActive: false } });
    res.status(204).send();
  },
);
