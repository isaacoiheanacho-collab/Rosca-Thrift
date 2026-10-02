/**
 * Auth middleware — verifies access tokens and enforces roles.
 *
 * The JWT payload is attached to `req.user`. Missing/invalid tokens
 * produce typed AuthenticationError / AuthorizationError (handled by errorHandler).
 */

import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, type JwtPayload } from '../utils/jwt';
import { AuthenticationError, AuthorizationError } from '../errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AuthenticationError('Missing or invalid Authorization header', 'AUTH_REQUIRED'));
  }

  const token = header.slice('Bearer '.length).trim();
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new AuthenticationError('Invalid or expired token', 'AUTH_TOKEN_INVALID'));
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (req.user?.role !== 'ADMIN') {
      return next(new AuthorizationError('Admin access required', 'AUTH_ADMIN_REQUIRED'));
    }
    next();
  });
}