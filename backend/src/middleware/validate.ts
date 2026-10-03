/**
 * Request validation middleware (Zod).
 *
 * Express 5 makes req.body/query/params read-only getters. We override the
 * getter using Object.defineProperty so we can swap in the parsed values
 * without mutating the original property.
 *
 * Usage in a route:
 *   router.post('/x', validate({ body: SomeSchema }), handler)
 */

import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function redefine<T extends object>(target: T, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.params) {
        const parsed = schemas.params.parse(req.params);
        redefine(req, 'params', parsed);
      }
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        redefine(req, 'query', parsed);
      }
      if (schemas.body) {
        const parsed = schemas.body.parse(req.body);
        redefine(req, 'body', parsed);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}