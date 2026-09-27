/**
 * permission.middleware.ts — Feature guards for admin routes.
 * ──────────────────────────────────────────────────────────
 * `requireFeature` is the usual guard: mounted on a router, it reads for GET and
 * writes for everything else, which matches how every admin router is shaped and
 * keeps the permission decision in one line per feature.
 *
 * Permissions are resolved per request rather than carried in the JWT: a role
 * edit must take effect immediately, and a token issued an hour ago would
 * otherwise keep its old access until it expired.
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/app-error.js';
import { hasPermission } from '../services/roles.service.js';

/** Methods that only read. Everything else needs the `manage` permission. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function assert(req: Request, permission: string): Promise<void> {
  if (!req.user) throw AppError.unauthorized();
  const allowed = await hasPermission(req.user.id, req.user.role, permission);
  if (!allowed) {
    throw AppError.forbidden(`Your role does not allow this (${permission} required).`);
  }
}

/** Require one specific permission key. */
export function requirePermission(permission: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    await assert(req, permission);
    next();
  };
}

/**
 * Require `<feature>.view` to read and `<feature>.manage` to change anything.
 * Pass `manageOnly` for features that have no read-only mode (MCP tokens).
 */
export function requireFeature(feature: string, manageOnly = false) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const action = !manageOnly && READ_METHODS.has(req.method) ? 'view' : 'manage';
    await assert(req, `${feature}.${action}`);
    next();
  };
}
