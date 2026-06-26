import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  type: 'access';
  iat: number;
  exp: number;
}

interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  iat: number;
  exp: number;
}

export function parseAccessToken(token: string): AccessTokenPayload {
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw AppError.unauthorized('Invalid or expired token');
  }
  const p = payload as AccessTokenPayload;
  if (p.type !== 'access') throw AppError.unauthorized('Invalid token type');
  return p;
}

export function parseRefreshToken(token: string): RefreshTokenPayload {
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw AppError.unauthorized('Invalid or expired refresh token');
  }
  const p = payload as RefreshTokenPayload;
  if (p.type !== 'refresh') throw AppError.unauthorized('Invalid token type');
  return p;
}

/** Middleware: requires a valid Bearer access token. Sets req.user. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or malformed Authorization header');
  }
  const payload = parseAccessToken(authHeader.slice(7));
  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
}

/** Middleware: requires the authenticated user to have the given role. */
export function requireRole(role: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw AppError.unauthorized();
    if (req.user.role !== role) throw AppError.forbidden();
    next();
  };
}
