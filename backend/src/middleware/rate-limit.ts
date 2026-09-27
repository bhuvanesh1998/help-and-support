/**
 * rate-limit.ts — Throttles for the paths worth guessing at.
 * ────────────────────────────────────────────────────────
 * The credential endpoints are the ones an attacker can use without an account,
 * so they get a strict per-IP budget. Everything else gets a generous ceiling
 * that a person cannot reach but a script can.
 *
 * Counters are in-process. That is honest for a single container and still worth
 * having: it turns unlimited guessing into a handful of tries per window. Behind
 * more than one replica, move the store to Redis — otherwise the effective limit
 * multiplies by the replica count.
 */

import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';

const MINUTE = 60 * 1000;

/** One JSON shape for refusals, matching the global error handler. */
function limitHandler(req: Request, res: Response): void {
  logger.warn('rate limit hit', { path: req.path, ip: req.ip });
  res.status(429).json({
    error: {
      message: 'Too many requests. Wait a minute and try again.',
      code: 'RATE_LIMITED',
    },
  });
}

const shared: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
};

/**
 * Login and refresh: enough for a person who has forgotten which password they
 * used, nowhere near enough to work through a list.
 *
 * Keyed by IP **and** the submitted email, so one attacker cannot lock a
 * colleague out of their own account by burning the shared-office IP budget on
 * it — and spraying one password across many accounts still costs a slot each.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * MINUTE,
  limit: 10,
  // Only failures count. A working session refreshing normally is not an attack.
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.toLowerCase().trim() : '';
    // ipKeyGenerator normalises IPv6 so a /64 cannot be used as an unlimited
    // pool of distinct keys.
    return `${ipKeyGenerator(req.ip ?? '')}:${email}`;
  },
});

/**
 * The rest of the admin API. High enough that the polling library screen and a
 * long day of editing never notice; low enough to stop enumeration.
 */
export const adminLimiter = rateLimit({
  ...shared,
  windowMs: 15 * MINUTE,
  limit: 1200,
  skip: (req: Request) =>
    // Server-sent event streams are one long-lived request that would otherwise
    // hold a slot for the whole job, and their own auth already gates them.
    req.path.endsWith('/stream'),
});

/**
 * Public read + analytics endpoints, which any visitor can reach. Generous
 * because a single help-centre page view fires several of them.
 */
export const publicLimiter = rateLimit({
  ...shared,
  windowMs: MINUTE,
  limit: 240,
});
