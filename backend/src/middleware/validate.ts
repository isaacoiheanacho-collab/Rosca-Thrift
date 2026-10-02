/**
 * Request validation middleware (Zod).
 *
 * Usage in a route:
 *   router.post('/x', validate({ body: SomeSchema }), handler)
 *
 * Replaces req.body/query/params with the parsed (and type-safe) values.
 * Any failure throws ZodError → caught by errorHandler → 400.
 */

import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) req.query = schemas.query.parse(req.query) as typeof req.query;
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}