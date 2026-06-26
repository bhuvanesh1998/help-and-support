import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/app-error.js';

/** Converts unmatched routes into a structured 404 handled by errorHandler. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}
