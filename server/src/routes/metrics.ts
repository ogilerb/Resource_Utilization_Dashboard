import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validateQuery, getValidatedQuery } from '../middleware/validate.js';
import { categoryTiers } from '../lib/calendars.js';

export const metricsRouter = Router();

const rangeSchema = z.object({
  resource_id: z.coerce.number().int().positive(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Cap points returned; the client can request a coarser view for wide ranges.
  limit: z.coerce.number().int().positive().max(50_000).default(5_000),
});

// Same as rangeSchema plus a bucket size for on-the-fly aggregation.
const bucketedSchema = rangeSchema.extend({
  bucket: z.enum(['hour', 'day']),
});

// Usage gauges are sampled sparsely (~15 min), so their wide views bucket by
// day (month view) or week (year view) rather than hour/day.
const usageBucketedSchema = rangeSchema.extend({
  bucket: z.enum(['day', 'week']),
});

// Calendar time buckets are already per-day; the year view rolls them up to weeks.
const timeBucketedSchema = rangeSchema.extend({
  bucket: z.enum(['day', 'week']),
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

// GET /api/metrics/compute/bucketed?resource_id=&from=&to=&bucket=hour|day
// On-the-fly downsample of *recent* raw compute_metrics: averages every sample
// in each hour/day into one point. Powers the 24h (per-hour) and 7d (per-day)
// chart views, where plotting every raw 15s sample is unreadable. Unlike
// /compute/hourly this reads live raw rows, so it works for data newer than the
// retention rollup window.
metricsRouter.get('/compute/bucketed', validateQuery(bucketedSchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof bucketedSchema>>(req);
    const { rows } = await query(
      `SELECT date_trunc($5::text, timestamp) AS timestamp,
              avg(cpu_percent)::real    AS cpu_percent_avg,
              max(cpu_percent)::real    AS cpu_percent_max,
              avg(memory_bytes)::bigint AS memory_bytes_avg,
              max(memory_bytes)::bigint AS memory_bytes_max,
              count(*)::int             AS sample_count
         FROM compute_metrics
        WHERE resource_id = $1
          AND ($2::timestamptz IS NULL OR timestamp >= $2)
          AND ($3::timestamptz IS NULL OR timestamp <= $3)
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT $4`,
      [q.resource_id, q.from ?? null, q.to ?? null, q.limit, q.bucket]
    );
    res.json({ resource_id: q.resource_id, points: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/usage?resource_id=&from=&to= — subscription usage gauge
// samples (percent-of-limit per window over time).
metricsRouter.get('/usage', validateQuery(rangeSchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof rangeSchema>>(req);
    const { rows } = await query(
      `SELECT timestamp, window_kind, utilization, resets_at, raw
         FROM usage_metrics
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

// GET /api/metrics/usage/bucketed?resource_id=&from=&to=&bucket=day|week
// On-the-fly downsample of raw usage_metrics: averages every gauge sample in
// each day/week into one point, per window_kind. Powers the month (per-day) and
// year (per-week) usage views, where plotting every raw ~15 min sample over such
// a wide range is unreadable. utilization_max preserves the peak the gauge
// reached within the bucket for the tooltip.
//
// pace_avg/pace_max track how close usage is to keeping up with an even weekly
// pace (100% = exactly on track). Per sample, pace = utilization / fraction of
// the week elapsed at that sample (from resets_at), so it stays flat across the
// weekly reset instead of sawtoothing back to 0 like raw utilization. Only
// meaningful for the resetting seven_day window; NULL otherwise, and NULL in the
// first ~5% of a week where the ratio is too noisy. avg()/max() ignore the NULLs.
metricsRouter.get('/usage/bucketed', validateQuery(usageBucketedSchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof usageBucketedSchema>>(req);
    const { rows } = await query(
      `SELECT date_trunc($5::text, timestamp) AS timestamp,
              window_kind,
              avg(utilization)::real AS utilization_avg,
              max(utilization)::real AS utilization_max,
              avg(pace)::real        AS pace_avg,
              max(pace)::real        AS pace_max,
              count(*)::int          AS sample_count
         FROM (
           SELECT timestamp, window_kind, utilization,
                  CASE
                    WHEN window_kind = 'seven_day' AND resets_at IS NOT NULL
                     AND extract(epoch FROM (timestamp - (resets_at - interval '7 days'))) / 604800.0 > 0.05
                    THEN utilization
                       / LEAST(1.0, extract(epoch FROM (timestamp - (resets_at - interval '7 days'))) / 604800.0)
                  END AS pace
             FROM usage_metrics
            WHERE resource_id = $1
              AND ($2::timestamptz IS NULL OR timestamp >= $2)
              AND ($3::timestamptz IS NULL OR timestamp <= $3)
         ) s
        GROUP BY 1, window_kind
        ORDER BY 1 ASC
        LIMIT $4`,
      [q.resource_id, q.from ?? null, q.to ?? null, q.limit, q.bucket]
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

// GET /api/metrics/time?resource_id=&from=&to= — daily minutes/event_count per
// category (life-domain). `categories` carries the config-order category→tier
// map so the panel can group (productive/neutral/waste), order, and color the
// stack consistently even for categories with no data in the window.
metricsRouter.get('/time', validateQuery(rangeSchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof rangeSchema>>(req);
    const { rows } = await query(
      // to_char keeps `day` a plain 'YYYY-MM-DD' string. Without it node-pg maps
      // the DATE column to a JS Date, which res.json serializes as a full ISO
      // timestamp — the client then can't parse it as a local day.
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, category, minutes, event_count
         FROM time_metrics
        WHERE resource_id = $1
          AND ($2::timestamptz IS NULL OR day >= $2::date)
          AND ($3::timestamptz IS NULL OR day <= $3::date)
        ORDER BY day ASC, category ASC
        LIMIT $4`,
      [q.resource_id, q.from ?? null, q.to ?? null, q.limit]
    );
    res.json({ resource_id: q.resource_id, points: rows, categories: categoryTiers() });
  } catch (err) {
    next(err);
  }
});

// GET /api/metrics/time/bucketed?resource_id=&from=&to=&bucket=day|week
// Rolls the per-day rows up to day or week buckets (year view uses week) by
// summing minutes/event_count per bucket per category.
metricsRouter.get('/time/bucketed', validateQuery(timeBucketedSchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof timeBucketedSchema>>(req);
    const { rows } = await query(
      // to_char → plain 'YYYY-MM-DD' string (see /time note).
      `SELECT to_char(date_trunc($5::text, day::timestamp), 'YYYY-MM-DD') AS day,
              category,
              sum(minutes)::int     AS minutes,
              sum(event_count)::int AS event_count
         FROM time_metrics
        WHERE resource_id = $1
          AND ($2::timestamptz IS NULL OR day >= $2::date)
          AND ($3::timestamptz IS NULL OR day <= $3::date)
        GROUP BY 1, category
        ORDER BY 1 ASC, category ASC
        LIMIT $4`,
      [q.resource_id, q.from ?? null, q.to ?? null, q.limit, q.bucket]
    );
    res.json({ resource_id: q.resource_id, points: rows, categories: categoryTiers() });
  } catch (err) {
    next(err);
  }
});
