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
  // Optional: restrict to one usage resource. Omitted → all usage resources.
  resource_id: z.coerce.number().int().positive().optional(),
  weeks: z.coerce.number().int().positive().max(26).default(6),
});

// GET /api/analytics/usage-weekly?resource_id=&weeks= — the 'seven_day' usage
// gauge broken into one full curve PER weekly cycle, so the graph view can
// overlay each week on a shared "days since reset" x-axis (not aggregated to a
// single number). Each cycle is keyed by its reset time: cycle_start =
// resets_at - 7d, and every point carries `t` = days elapsed since cycle_start
// (0..7). Cycles without a reset time fall back to the calendar week.
analyticsRouter.get('/usage-weekly', validateQuery(usageWeeklySchema), async (req, res, next) => {
  try {
    const q = getValidatedQuery<z.infer<typeof usageWeeklySchema>>(req);
    const { rows } = await query(
      `SELECT cycle_start, resets_at, sample_count, points
         FROM (
           SELECT cycle_start,
                  max(resets_at)                                            AS resets_at,
                  count(*)::int                                             AS sample_count,
                  json_agg(json_build_object(
                    't', round((extract(epoch FROM (timestamp - cycle_start)) / 86400.0)::numeric, 4),
                    'u', utilization
                  ) ORDER BY timestamp)                                     AS points
             FROM (
               SELECT timestamp, utilization, resets_at,
                      COALESCE(resets_at - interval '7 days',
                               date_trunc('week', timestamp)) AS cycle_start
                 FROM usage_metrics
                WHERE window_kind = 'seven_day'
                  AND ($1::int IS NULL OR resource_id = $1)
                  AND timestamp >= now() - (($2::int + 1) || ' weeks')::interval
             ) s
            GROUP BY cycle_start
            ORDER BY cycle_start DESC
            LIMIT $2::int
         ) recent
        ORDER BY cycle_start ASC`,
      [q.resource_id ?? null, q.weeks]
    );
    res.json({ weeks: rows });
  } catch (err) {
    next(err);
  }
});
