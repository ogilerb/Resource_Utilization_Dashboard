import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requireApiKey } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ingestLimiter } from '../middleware/rateLimit.js';
import { broadcastCompute } from '../ws/broadcast.js';

export const ingestRouter = Router();

const computeSchema = z.object({
  cpu_percent: z.number().min(0).max(100).nullable().optional(),
  memory_bytes: z.number().int().nonnegative().nullable().optional(),
  // Optional client-supplied capture time; defaults to server now() if absent.
  timestamp: z.string().datetime().optional(),
});

// POST /api/ingest/compute — agents push a single compute datapoint.
// The resource is resolved from the API key, so this route is fully generic:
// registering a new machine needs no new route or code.
ingestRouter.post(
  '/compute',
  ingestLimiter,
  requireApiKey,
  validateBody(computeSchema),
  async (req, res, next) => {
    try {
      const resource = req.resource!;
      if (resource.type !== 'compute') {
        res.status(400).json({ error: `Resource "${resource.name}" is not of type compute` });
        return;
      }
      const body = req.body as z.infer<typeof computeSchema>;
      const { rows } = await query<{ timestamp: string }>(
        `INSERT INTO compute_metrics (resource_id, cpu_percent, memory_bytes, timestamp)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
         RETURNING timestamp`,
        [resource.id, body.cpu_percent ?? null, body.memory_bytes ?? null, body.timestamp ?? null]
      );

      broadcastCompute({
        resourceId: resource.id,
        timestamp: rows[0].timestamp,
        cpu_percent: body.cpu_percent ?? null,
        memory_bytes: body.memory_bytes ?? null,
      });

      res.status(202).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

const apiUsageSchema = z.object({
  // Aggregation day (YYYY-MM-DD). Defaults to today (UTC) if absent.
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
  // When true, add to the existing day's totals (e.g. the Gemini web estimator
  // streaming increments); otherwise replace the day's totals (billing snapshot).
  increment: z.boolean().default(false),
});

// POST /api/ingest/api — usage/cost push for 'api' resources.
// Used by the Gemini web-app estimator (browser extension / proxy) and by any
// source that prefers push over the pull workers. Idempotent per (resource, day).
ingestRouter.post(
  '/api',
  ingestLimiter,
  requireApiKey,
  validateBody(apiUsageSchema),
  async (req, res, next) => {
    try {
      const resource = req.resource!;
      if (resource.type !== 'api') {
        res.status(400).json({ error: `Resource "${resource.name}" is not of type api` });
        return;
      }
      const body = req.body as z.infer<typeof apiUsageSchema>;
      const day = body.day ?? new Date().toISOString().slice(0, 10);

      const conflict = body.increment
        ? `tokens_in = api_metrics.tokens_in + EXCLUDED.tokens_in,
           tokens_out = api_metrics.tokens_out + EXCLUDED.tokens_out,
           cost = api_metrics.cost + EXCLUDED.cost`
        : `tokens_in = EXCLUDED.tokens_in,
           tokens_out = EXCLUDED.tokens_out,
           cost = EXCLUDED.cost`;

      await query(
        `INSERT INTO api_metrics (resource_id, day, tokens_in, tokens_out, cost)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (resource_id, day) DO UPDATE SET
           ${conflict},
           timestamp = now()`,
        [resource.id, day, body.tokens_in, body.tokens_out, body.cost]
      );

      res.status(202).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);
