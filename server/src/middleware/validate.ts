import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, infer as zInfer } from 'zod';

/**
 * Validate `req.body` against a zod schema, replacing it with the parsed
 * (coerced, stripped) value. Responds 400 with field errors on failure.
 */
export function validateBody<S extends ZodTypeAny>(schema: S) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      return;
    }
    req.body = result.data as zInfer<S>;
    next();
  };
}

/** Same, for query-string params. */
export function validateQuery<S extends ZodTypeAny>(schema: S) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      return;
    }
    // req.query is a read-only getter in Express 5; stash parsed values instead.
    (req as Request & { validatedQuery?: unknown }).validatedQuery = result.data;
    next();
  };
}

export function getValidatedQuery<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery as T;
}
