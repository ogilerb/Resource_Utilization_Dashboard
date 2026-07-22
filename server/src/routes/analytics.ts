import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validateQuery, getValidatedQuery } from '../middleware/validate.js';

export const analyticsRouter = Router();

// Period-over-period comparison per resource, powering the dashboard's
// week-over-week / month-over-month analytics.
//
// Windows are ROLLING (not calendar) to avoid partial-week noise:
//   week:  now-7d..now   vs  now-14d..now-7d
//   month: now-30d..now  vs  now-60d..now-30d
//
// Primary metric per type:
//   compute → avg(cpu_percent)  (also returns avg(memory_bytes) as secondary)
//   usage   → avg(utilization) where window_kind='seven_day'
//   api     → sum(cost)         (also returns summed tokens as secondary)

interface PeriodDelta {
  current: number | null;
  previous: number | null;
  delta_pct: number | null; // null when previous is null/0 (client shows "—"/"new")
}

interface Metric {
  metric: string;
  week: PeriodDelta;
  month: PeriodDelta;
}

function delta(current: number | null, previous: number | null): PeriodDelta {
  const cur = current == null ? null : Number(current);
  const prev = previous == null ? null : Number(previous);
  const delta_pct =
    cur != null && prev != null && prev !== 0 ? ((cur - prev) / prev) * 100 : null;
  return { current: cur, previous: prev, delta_pct };
}

function metric(
  name: string,
  row: Record<string, number | null> | undefined,
  key: string
): Metric {
  const r = row ?? {};
  return {
    metric: name,
    week: delta(r[`${key}_cur_w`] ?? null, r[`${key}_prev_w`] ?? null),
    month: delta(r[`${key}_cur_m`] ?? null, r[`${key}_prev_m`] ?? null),
  };
}

analyticsRouter.get('/summary', async (_req, res, next) => {
  try {
    const [resources, compute, usage, api] = await Promise.all([
      query<{ id: number; type: string }>(
        `SELECT id, type FROM resources ORDER BY created_at ASC`
      ),
      query(
        `SELECT resource_id,
           avg(cpu_percent)  FILTER (WHERE timestamp >= now()-interval '7 days')                                         AS cpu_cur_w,
           avg(cpu_percent)  FILTER (WHERE timestamp >= now()-interval '14 days' AND timestamp < now()-interval '7 days') AS cpu_prev_w,
           avg(cpu_percent)  FILTER (WHERE timestamp >= now()-interval '30 days')                                        AS cpu_cur_m,
           avg(cpu_percent)  FILTER (WHERE timestamp >= now()-interval '60 days' AND timestamp < now()-interval '30 days') AS cpu_prev_m,
           avg(memory_bytes) FILTER (WHERE timestamp >= now()-interval '7 days')                                         AS mem_cur_w,
           avg(memory_bytes) FILTER (WHERE timestamp >= now()-interval '14 days' AND timestamp < now()-interval '7 days') AS mem_prev_w,
           avg(memory_bytes) FILTER (WHERE timestamp >= now()-interval '30 days')                                        AS mem_cur_m,
           avg(memory_bytes) FILTER (WHERE timestamp >= now()-interval '60 days' AND timestamp < now()-interval '30 days') AS mem_prev_m
         FROM compute_metrics
         WHERE timestamp >= now()-interval '60 days'
         GROUP BY resource_id`
      ),
      query(
        `SELECT resource_id,
           avg(utilization) FILTER (WHERE timestamp >= now()-interval '7 days')                                         AS util_cur_w,
           avg(utilization) FILTER (WHERE timestamp >= now()-interval '14 days' AND timestamp < now()-interval '7 days') AS util_prev_w,
           avg(utilization) FILTER (WHERE timestamp >= now()-interval '30 days')                                        AS util_cur_m,
           avg(utilization) FILTER (WHERE timestamp >= now()-interval '60 days' AND timestamp < now()-interval '30 days') AS util_prev_m
         FROM usage_metrics
         WHERE timestamp >= now()-interval '60 days' AND window_kind = 'seven_day'
         GROUP BY resource_id`
      ),
      query(
        `SELECT resource_id,
           sum(cost)                    FILTER (WHERE day > current_date - 7)                               AS cost_cur_w,
           sum(cost)                    FILTER (WHERE day > current_date - 14 AND day <= current_date - 7)  AS cost_prev_w,
           sum(cost)                    FILTER (WHERE day > current_date - 30)                              AS cost_cur_m,
           sum(cost)                    FILTER (WHERE day > current_date - 60 AND day <= current_date - 30) AS cost_prev_m,
           sum(tokens_in + tokens_out)  FILTER (WHERE day > current_date - 7)                               AS tok_cur_w,
           sum(tokens_in + tokens_out)  FILTER (WHERE day > current_date - 14 AND day <= current_date - 7)  AS tok_prev_w,
           sum(tokens_in + tokens_out)  FILTER (WHERE day > current_date - 30)                              AS tok_cur_m,
           sum(tokens_in + tokens_out)  FILTER (WHERE day > current_date - 60 AND day <= current_date - 30) AS tok_prev_m
         FROM api_metrics
         WHERE day > current_date - 60
         GROUP BY resource_id`
      ),
    ]);

    const computeBy = new Map(compute.rows.map((r) => [r['resource_id'], r]));
    const usageBy = new Map(usage.rows.map((r) => [r['resource_id'], r]));
    const apiBy = new Map(api.rows.map((r) => [r['resource_id'], r]));

    const out = resources.rows.map((r) => {
      switch (r.type) {
        case 'compute': {
          const row = computeBy.get(r.id) as Record<string, number | null> | undefined;
          return {
            resource_id: r.id,
            type: r.type,
            ...metric('cpu_percent', row, 'cpu'),
            secondary: metric('memory_bytes', row, 'mem'),
          };
        }
        case 'usage': {
          const row = usageBy.get(r.id) as Record<string, number | null> | undefined;
          return { resource_id: r.id, type: r.type, ...metric('utilization', row, 'util') };
        }
        case 'api': {
          const row = apiBy.get(r.id) as Record<string, number | null> | undefined;
          return {
            resource_id: r.id,
            type: r.type,
            ...metric('cost', row, 'cost'),
            secondary: metric('tokens', row, 'tok'),
          };
        }
        default:
          return { resource_id: r.id, type: r.type, metric: 'unknown', week: delta(null, null), month: delta(null, null) };
      }
    });

    res.json({ resources: out });
  } catch (err) {
    next(err);
  }
});

const usageWeeklySchema = z.object({
  // Optional: restrict to one usage resource. Omitted → averaged across all.
  resource_id: z.coerce.number().int().positive().optional(),
  weeks: z.coerce.number().int().positive().max(52).default(12),
});

// GET /api/analytics/usage-weekly?resource_id=&weeks= — average subscription
// usage percentage bucketed by calendar week (ISO week, Monday start). Powers
// the analytics graph view. Uses the headline 'seven_day' gauge only.
analyticsRouter.get('/usage-weekly', validateQuery(usageWeeklySchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof usageWeeklySchema>>(req);
    const { rows } = await query(
      `SELECT date_trunc('week', timestamp) AS week_start,
              avg(utilization)::real        AS avg_utilization,
              max(utilization)::real        AS max_utilization,
              count(*)::int                 AS sample_count
         FROM usage_metrics
        WHERE window_kind = 'seven_day'
          AND ($1::int IS NULL OR resource_id = $1)
          AND timestamp >= date_trunc('week', now()) - (($2 - 1) || ' weeks')::interval
        GROUP BY 1
        ORDER BY 1 ASC`,
      [q.resource_id ?? null, q.weeks]
    );
    res.json({ weeks: rows });
  } catch (err) {
    next(err);
  }
});
