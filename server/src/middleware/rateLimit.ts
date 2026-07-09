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
