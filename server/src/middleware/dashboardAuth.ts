import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Constant-time comparison of a presented token against the configured dashboard
 * token. Returns false (never throws) when the token is unset or lengths differ,
 * so callers can treat any falsy result as "denied".
 */
export function dashboardTokenValid(presented: string): boolean {
  const expected = config.dashboardToken;
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; unequal length is itself a mismatch.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the token from `Authorization: Bearer <t>` or `X-Dashboard-Token: <t>`. */
export function extractDashboardToken(req: Request): string {
  const bearer = req.header('authorization') ?? '';
  if (bearer.startsWith('Bearer ')) return bearer.slice(7);
  return req.header('x-dashboard-token') ?? '';
}

/**
 * Gate read/admin (non-ingest) endpoints behind the dashboard token.
 *
 * FAILS CLOSED: if no DASHBOARD_TOKEN is configured, every protected request is
 * refused with 503 rather than served openly — so forgetting to set the secret
 * makes the dashboard unavailable, never public. Ingest routes are intentionally
 * NOT covered here; they authenticate with their own per-agent API keys.
 */
export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.dashboardToken) {
    res.status(503).json({ error: 'Dashboard auth not configured (set DASHBOARD_TOKEN)' });
    return;
  }
  if (!dashboardTokenValid(extractDashboardToken(req))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
