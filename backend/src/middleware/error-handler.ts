import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/app-error.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

interface ErrorBody {
  error: {
    message: string;
    code: string;
    details?: unknown;
    stack?: string;
  };
}

/**
 * Single source of truth for error responses. Express 5 forwards rejected
 * async handlers here automatically, so controllers can simply `throw`.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // `next` is required for Express to recognise this as an error handler.
  _next: NextFunction,
): void {
  let statusCode = 500;
  let message = 'Internal server error';
  let code = 'INTERNAL_ERROR';
  let details: unknown;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    code = err.code ?? code;
    details = err.details;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    ({ statusCode, message, code } = mapPrismaError(err));
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    statusCode = 400;
    message = 'Invalid database query input';
    code = 'PRISMA_VALIDATION';
  } else if (err instanceof Error) {
    message = err.message || message;
  }

  if (statusCode >= 500) {
    logger.error('Unhandled error', { code, message, stack: errStack(err) });
  } else {
    logger.warn('Handled error', { code, statusCode, message });
  }

  const body: ErrorBody = { error: { message, code } };
  if (details !== undefined) body.error.details = details;
  if (!env.isProduction) body.error.stack = errStack(err);

  res.status(statusCode).json(body);
}

function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): {
  statusCode: number;
  message: string;
  code: string;
} {
  switch (err.code) {
    case 'P2002':
      return { statusCode: 409, message: 'A record with this value already exists', code: 'UNIQUE_VIOLATION' };
    case 'P2025':
      return { statusCode: 404, message: 'Record not found', code: 'NOT_FOUND' };
    case 'P2003':
      return { statusCode: 409, message: 'Related record constraint failed', code: 'FK_VIOLATION' };
    default:
      return { statusCode: 400, message: 'Database request error', code: `PRISMA_${err.code}` };
  }
}

function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}
