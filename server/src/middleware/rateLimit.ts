import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

/**
 * Rate limit ingest by API key (falling back to IP for unauthenticated
 * requests, which are rejected by auth anyway). Keeps a single noisy agent from
 * overwhelming the ingest path.
 */
export const ingestLimiter = rateLimit({
  windowMs: config.ingestRate.windowMs,
  max: config.ingestRate.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.header('x-api-key') ||
    (req.header('authorization')?.replace(/^Bearer /, '') ?? '') ||
    req.ip ||
    'unknown',
  message: { error: 'Rate limit exceeded' },
});

/**
 * Throttle repeated FAILED dashboard-token attempts per IP. Normal authenticated
 * traffic (200s) and validation errors don't consume the budget — only 401s do —
 * so honest polling is never limited, but online guessing of the token is capped.
 * The token is 32 random bytes (not brute-forceable); this is belt-and-suspenders
 * plus basic abuse/DoS protection.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  keyGenerator: (req) => req.ip || 'unknown',
  message: { error: 'Too many failed attempts; try again later' },
});
