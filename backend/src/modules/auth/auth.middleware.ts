import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/AppError';
import { authenticateAccessToken } from './auth.service';

declare global {
  namespace Express {
    interface Request { auth?: { userId: string; role: string } }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next(new AppError({
    code: 'UNAUTHENTICATED', httpStatus: 401, message: 'A valid access token is required',
  }));
  try {
    req.auth = authenticateAccessToken(header.slice(7));
    next();
  } catch (error) { next(error); }
}
