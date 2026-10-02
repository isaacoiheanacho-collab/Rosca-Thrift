/**
 * Central error handler.
 *
 *  - AppError → structured JSON with stable code + HTTP status
 *  - ZodError → 400 with field-level details
 *  - Anything else → 500 generic message (never leaks internals)
 *
 * Always logs with requestId, route, method, and duration.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError';
import { logger } from '../logger';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const log = req.log ?? logger;

  if (err instanceof ZodError) {
    log.warn({ err: err.issues }, 'Request validation failed');
    res.status(400).json({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: err.issues },
      },
    });
    return;
  }

  if (err instanceof AppError) {
    const level = err.httpStatus >= 500 ? 'error' : 'warn';
    log[level]({ err, code: err.code }, err.message);
    res.status(err.httpStatus).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  log.error({ err }, 'Unhandled error');
  res.status(500).json({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
}