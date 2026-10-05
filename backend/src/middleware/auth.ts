/**
 * Auth middleware — verify access tokens and enforce role/branch scope.
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

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);

    if (req.user?.role !== 'SUPER_ADMIN') {
      return next(new AuthorizationError('Super admin access required', 'AUTH_SUPER_ADMIN_REQUIRED'));
    }

    next();
  });
}

export function requireBranchAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);

    if (req.user?.role !== 'BRANCH_ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
      return next(
        new AuthorizationError('Branch admin access required', 'AUTH_BRANCH_ADMIN_REQUIRED'),
      );
    }

    next();
  });
}

/**
 * Ensures the caller can act on the given branchId:
 *   - SUPER_ADMIN: any branch
 *   - BRANCH_ADMIN: only their own branch
 */
export function requireBranchScope(paramName = 'branchId') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;

    if (!user) {
      return next(new AuthenticationError('Not authenticated', 'AUTH_REQUIRED'));
    }

    if (user.role === 'SUPER_ADMIN') {
      return next();
    }

    const target = String(req.params[paramName] ?? req.body?.[paramName] ?? '');

    if (!target) {
      return next(new AuthorizationError('Missing branchId', 'AUTH_MISSING_BRANCH'));
    }

    if (user.role === 'BRANCH_ADMIN' && user.branchId === target) {
      return next();
    }

    next(new AuthorizationError('Not permitted for this branch', 'AUTH_BRANCH_SCOPE'));
  };
}