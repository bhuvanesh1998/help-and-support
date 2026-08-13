import { Router } from 'express';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { authenticate, parseRefreshToken } from '../middleware/auth.middleware.js';
import { logger } from '../lib/logger.js';
import { resolveAccess } from '../services/roles.service.js';

export const authRouter: Router = Router();

/** POST /api/admin/auth/login */
authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw AppError.badRequest('email and password are required');
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.isActive) throw AppError.unauthorized('Invalid credentials');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw AppError.unauthorized('Invalid credentials');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  // `tv` pins the token to the account's current version, so "sign out of all
  // devices" and password changes can invalidate it without server-side session
  // storage.
  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, tv: user.tokenVersion, type: 'access' },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn } as object,
  );
  const refreshToken = jwt.sign(
    { sub: user.id, tv: user.tokenVersion, type: 'refresh' },
    env.jwtSecret,
    { expiresIn: env.jwtRefreshExpiresIn } as object,
  );

  res.json({ accessToken, refreshToken, expiresIn: env.jwtExpiresIn });
});

/** POST /api/admin/auth/refresh */
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: unknown };
  if (typeof refreshToken !== 'string') {
    throw AppError.badRequest('refreshToken is required');
  }

  const payload = parseRefreshToken(refreshToken);
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive) throw AppError.unauthorized('User not found or inactive');

  // A refresh token from before a logout-everywhere (or a password change) is
  // dead, exactly like the access tokens it could otherwise keep minting.
  if ((payload.tv ?? 0) !== user.tokenVersion) {
    throw AppError.unauthorized('Session ended. Please sign in again.');
  }

  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, tv: user.tokenVersion, type: 'access' },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn } as object,
  );
  // Rotated on every use: a captured refresh token is worth one exchange rather
  // than a week of silent access.
  const nextRefresh = jwt.sign(
    { sub: user.id, tv: user.tokenVersion, type: 'refresh' },
    env.jwtSecret,
    { expiresIn: env.jwtRefreshExpiresIn } as object,
  );

  res.json({ accessToken, refreshToken: nextRefresh, expiresIn: env.jwtExpiresIn });
});

/**
 * POST /api/admin/auth/logout
 *
 * Bumps the account's token version, which invalidates every access and refresh
 * token already issued to it. Clearing browser storage alone left a copied token
 * usable for the rest of its hour — and a refresh token for a week.
 *
 * Signing out on one device therefore signs out all of them. That is the safer
 * default for a shared-workstation admin tool, and it is the only behaviour that
 * makes "log out" mean anything to a token that has already leaked.
 */
authRouter.post('/logout', authenticate, async (req: Request, res: Response) => {
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { tokenVersion: { increment: 1 } },
  });
  logger.info('auth: signed out everywhere', { userId: req.user!.id });
  res.status(204).send();
});

/**
 * GET /api/admin/auth/me
 *
 * Carries the effective permissions so the UI can hide what the account cannot
 * use. They are advisory only — every endpoint re-checks server-side, and the
 * client list is refreshed here rather than baked into the token so a role edit
 * takes effect on the next load instead of on token expiry.
 */
authRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const access = await resolveAccess(req.user!.id, req.user!.role);
  res.json({ user: { ...req.user, ...access } });
});
