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
  // Machine's total usable RAM. Static per machine, so it's stored once as
  // resource metadata (not per-sample) and lets the dashboard plot memory as a
  // percentage of total, not just raw bytes.
  memory_total_bytes: z.number().int().positive().nullable().optional(),
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

      // Persist total RAM as resource metadata. It's static, so only write when
      // it's first reported or actually changes (a RAM upgrade) — in steady state
      // this is a cheap JS comparison against the value the auth middleware
      // already loaded, so no extra DB write happens on the ingest hot path.
      if (
        body.memory_total_bytes != null &&
        Number(resource.metadata?.['memory_total_bytes']) !== body.memory_total_bytes
      ) {
        await query(
          `UPDATE resources
              SET metadata = metadata || jsonb_build_object('memory_total_bytes', $2::bigint)
            WHERE id = $1`,
          [resource.id, body.memory_total_bytes]
        );
      }

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

const usageSampleSchema = z.object({
  window: z.string().min(1).max(64),
  utilization: z.number().min(0).max(1000), // percent; allow >100 for over-limit spend
  resets_at: z.string().datetime({ offset: true }).nullable().optional(),
  raw: z.record(z.unknown()).optional(),
});
const usagePushSchema = z.object({
  samples: z.array(usageSampleSchema).min(1).max(32),
});

// POST /api/ingest/usage — subscription usage gauges (e.g. Claude Pro).
// A collector samples percent-of-limit values for one or more windows
// ('five_hour', 'seven_day', 'extra_spend', ...) and pushes them in one call.
// Each push appends time-series rows; the dashboard shows the latest per window
// plus the trend over time.
ingestRouter.post(
  '/usage',
  ingestLimiter,
  requireApiKey,
  validateBody(usagePushSchema),
  async (req, res, next) => {
    try {
      const resource = req.resource!;
      if (resource.type !== 'usage') {
        res.status(400).json({ error: `Resource "${resource.name}" is not of type usage` });
        return;
      }
      const body = req.body as z.infer<typeof usagePushSchema>;
      for (const s of body.samples) {
        await query(
          `INSERT INTO usage_metrics (resource_id, window_kind, utilization, resets_at, raw)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [resource.id, s.window, s.utilization, s.resets_at ?? null, s.raw ? JSON.stringify(s.raw) : null]
        );
      }
      res.status(202).json({ ok: true, inserted: body.samples.length });
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
