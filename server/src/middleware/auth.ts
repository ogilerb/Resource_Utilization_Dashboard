import type { NextFunction, Request, Response } from 'express';
import { query } from '../db/pool.js';

export interface AuthedResource {
  id: number;
  name: string;
  type: 'compute' | 'api' | 'usage';
  interval_seconds: number;
}

// Augment Express's Request so downstream handlers see the resolved resource.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      resource?: AuthedResource;
    }
  }
}

/**
 * Resolve the calling agent's resource from its API key.
 * Ingest routes carry NO resource id in the URL — the key alone identifies the
 * resource, which is what keeps ingest fully generic (no per-resource routes).
 * Accepts `X-API-Key: <key>` or `Authorization: Bearer <key>`.
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header('x-api-key') ?? '';
  const bearer = req.header('authorization') ?? '';
  const key = header || (bearer.startsWith('Bearer ') ? bearer.slice(7) : '');

  if (!key) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }

  try {
    const { rows } = await query<AuthedResource>(
      `SELECT id, name, type, interval_seconds
         FROM resources
        WHERE api_key = $1 AND status = 'active'`,
      [key]
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    req.resource = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}
