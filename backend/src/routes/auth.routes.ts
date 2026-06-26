import { Router } from 'express';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { authenticate, parseRefreshToken } from '../middleware/auth.middleware.js';

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

  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'access' },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn } as object,
  );
  const refreshToken = jwt.sign(
    { sub: user.id, type: 'refresh' },
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

  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'access' },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn } as object,
  );

  res.json({ accessToken, expiresIn: env.jwtExpiresIn });
});

/** GET /api/admin/auth/me */
authRouter.get('/me', authenticate, (req: Request, res: Response) => {
  res.json({ user: req.user });
});
