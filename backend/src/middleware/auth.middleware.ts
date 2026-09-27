/**
 * auth.middleware.ts — Who is calling, and is that still true?
 * ───────────────────────────────────────────────────────────
 * A valid signature is not enough. The account behind a token can be
 * deactivated, deleted, demoted or logged out after the token was issued, and
 * until this file checked for that, a fired user kept full access for the rest of
 * the token's hour.
 *
 * So every authenticated request resolves the account from the database:
 *   • gone or inactive        → 401
 *   • `tokenVersion` moved on → 401 (logout-everywhere, password change)
 *   • role changed            → the *database* role is used, not the token's
 *
 * That is one primary-key lookup per request, which is the right trade against
 * an hour-long window where revocation does nothing.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/app-error.js';

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  /** Token version it was signed with; see User.tokenVersion. */
  tv?: number;
  type: 'access';
  iat: number;
  exp: number;
}

interface RefreshTokenPayload {
  sub: string;
  tv?: number;
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

/** The caller, as the database currently sees them. */
export interface AuthedUser {
  id: string;
  email: string;
  role: UserRole;
}

/**
 * Confirm the account behind a token still exists, is active, and has not been
 * logged out since the token was signed.
 *
 * Exported because the Voiceover Studio and AI pipeline authenticate per route
 * (their SSE streams and downloads use `?token=`), and they must apply exactly
 * the same rules as the global middleware.
 */
export async function resolveTokenUser(token: string): Promise<AuthedUser> {
  const payload = parseAccessToken(token);

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, role: true, isActive: true, tokenVersion: true },
  });

  if (!user) throw AppError.unauthorized('Account no longer exists');
  if (!user.isActive) throw AppError.unauthorized('This account has been deactivated');

  // Absent `tv` means a token issued before versioning existed; treat it as 0 so
  // deploying this does not sign everyone out mid-session.
  if ((payload.tv ?? 0) !== user.tokenVersion) {
    throw AppError.unauthorized('Session ended. Please sign in again.');
  }

  // The database role wins: a demotion must not wait for the token to expire.
  return { id: user.id, email: user.email, role: user.role };
}

/** Middleware: requires a valid Bearer access token for a live account. */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or malformed Authorization header');
  }
  req.user = await resolveTokenUser(authHeader.slice(7));
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
