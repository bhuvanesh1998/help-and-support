/**
 * Operational error with an HTTP status. "Operational" means an expected,
 * handled condition (bad input, not found, unauthorised) — distinct from a
 * programmer bug, which should surface as a generic 500.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: string | undefined;
  public readonly details: unknown;

  constructor(
    statusCode: number,
    message: string,
    options?: { code?: string; details?: unknown },
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = options?.code;
    this.details = options?.details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, message, { code: 'BAD_REQUEST', details });
  }

  static unauthorized(message = 'Unauthorized'): AppError {
    return new AppError(401, message, { code: 'UNAUTHORIZED' });
  }

  static forbidden(message = 'Forbidden'): AppError {
    return new AppError(403, message, { code: 'FORBIDDEN' });
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, message, { code: 'NOT_FOUND' });
  }

  static conflict(message: string): AppError {
    return new AppError(409, message, { code: 'CONFLICT' });
  }
}
