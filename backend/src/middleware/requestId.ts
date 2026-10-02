/**
 * Request ID middleware.
 *
 * Reads `x-request-id` if the client supplied one, otherwise generates
 * a fresh UUID. Attaches it to req, response header, and a child logger.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      log: typeof logger;
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && incoming.length <= 128 ? incoming : randomUUID();

  req.id = id;
  req.log = logger.child({ requestId: id });
  res.setHeader('x-request-id', id);

  next();
}