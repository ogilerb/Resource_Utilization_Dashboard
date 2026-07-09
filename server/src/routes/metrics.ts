import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validateQuery, getValidatedQuery } from '../middleware/validate.js';

export const metricsRouter = Router();

const rangeSchema = z.object({
  resource_id: z.coerce.number().int().positive(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Cap points returned; the client can request a coarser view for wide ranges.
  limit: z.coerce.number().int().positive().max(50_000).default(5_000),
});

// GET /api/metrics/compute?resource_id=&from=&to= — raw compute time-series.
// Rows are returned ascending by time so the chart can render them directly and
// detect gaps (sleep windows) between consecutive samples.
metricsRouter.get('/compute', validateQuery(rangeSchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof rangeSchema>>(req);
    const { rows } = await query(
      `SELECT timestamp, cpu_percent, memory_bytes
         FROM compute_metrics
        WHERE resource_id = $1
          AND ($2::timestamptz IS NULL OR timestamp >= $2)
          AND ($3::timestamptz IS NULL OR timestamp <= $3)
        ORDER BY timestamp ASC
        LIMIT $4`,
      [q.resource_id, q.from ?? null, q.to ?? null, q.limit]
    );
    res.json({ resource_id: q.resource_id, points: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/compute/hourly — downsampled series for long ranges.
metricsRouter.get('/compute/hourly', validateQuery(rangeSchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof rangeSchema>>(req);
    const { rows } = await query(
      `SELECT bucket AS timestamp, cpu_percent_avg, cpu_percent_max,
              memory_bytes_avg, memory_bytes_max, sample_count
         FROM compute_metrics_hourly
        WHERE resource_id = $1
          AND ($2::timestamptz IS NULL OR bucket >= $2)
          AND ($3::timestamptz IS NULL OR bucket <= $3)
        ORDER BY bucket ASC
        LIMIT $4`,
      [q.resource_id, q.from ?? null, q.to ?? null, q.limit]
    );
    res.json({ resource_id: q.resource_id, points: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/api?resource_id=&from=&to= — daily token/cost aggregates.
metricsRouter.get('/api', validateQuery(rangeSchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof rangeSchema>>(req);
    const { rows } = await query(
      `SELECT day, tokens_in, tokens_out, cost
         FROM api_metrics
        WHERE resource_id = $1
          AND ($2::timestamptz IS NULL OR day >= $2::date)
          AND ($3::timestamptz IS NULL OR day <= $3::date)
        ORDER BY day ASC
        LIMIT $4`,
      [q.resource_id, q.from ?? null, q.to ?? null, q.limit]
    );
    res.json({ resource_id: q.resource_id, points: rows });
  } catch (err) {
    next(err);
  }
});
