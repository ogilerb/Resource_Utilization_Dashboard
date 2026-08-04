import { pool, query } from '../db/pool.js';
import { generateApiKey } from '../lib/apiKey.js';

/**
 * Ensure an 'api' resource with the given name exists, returning its id.
 * Pull workers call this so their target resource auto-registers on first run —
 * no manual setup needed to start collecting Gemini/Claude usage.
 */
export async function ensureApiResource(name: string): Promise<number> {
  const existing = await query<{ id: number }>(
    `SELECT id FROM resources WHERE name = $1 AND type = 'api'`,
    [name]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const { rows } = await query<{ id: number }>(
    `INSERT INTO resources (name, type, api_key, interval_seconds, metadata)
     VALUES ($1, 'api', $2, 86400, '{"source":"pull-worker"}'::jsonb)
     ON CONFLICT (api_key) DO NOTHING
     RETURNING id`,
    [name, generateApiKey()]
  );
  if (rows.length > 0) return rows[0].id;

  // Lost a race; re-select.
  const retry = await query<{ id: number }>(
    `SELECT id FROM resources WHERE name = $1 AND type = 'api'`,
    [name]
  );
  return retry.rows[0].id;
}

/**
 * Ensure a 'calendar' (time-tracking) resource with the given name exists,
 * returning its id. The calendar worker calls this so its resource
 * auto-registers on first run. interval_seconds matches the ~hourly cron so the
 * offline badge reads correctly (liveness = last time_metrics write).
 */
export async function ensureCalendarResource(name: string): Promise<number> {
  const existing = await query<{ id: number }>(
    `SELECT id FROM resources WHERE name = $1 AND type = 'calendar'`,
    [name]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const { rows } = await query<{ id: number }>(
    `INSERT INTO resources (name, type, api_key, interval_seconds, metadata)
     VALUES ($1, 'calendar', $2, 3600, '{"source":"pull-worker"}'::jsonb)
     ON CONFLICT (api_key) DO NOTHING
     RETURNING id`,
    [name, generateApiKey()]
  );
  if (rows.length > 0) return rows[0].id;

  // Lost a race; re-select.
  const retry = await query<{ id: number }>(
    `SELECT id FROM resources WHERE name = $1 AND type = 'calendar'`,
    [name]
  );
  return retry.rows[0].id;
}

export interface TimeBucket {
  day: string; // YYYY-MM-DD (local)
  category: string;
  minutes: number;
  event_count: number;
}

/**
 * Idempotently replace a resource's time_metrics for every day >= sinceDay with
 * the freshly aggregated buckets, in one transaction. Delete-then-insert (rather
 * than upsert) so days/categories whose events were edited or deleted in Google
 * are correctly reflected — a plain upsert would leave stale rows behind.
 */
export async function replaceTimeMetrics(
  resourceId: number,
  sinceDay: string,
  buckets: TimeBucket[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM time_metrics WHERE resource_id = $1 AND day >= $2::date`, [
      resourceId,
      sinceDay,
    ]);
    for (const b of buckets) {
      await client.query(
        `INSERT INTO time_metrics (resource_id, day, category, minutes, event_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [resourceId, b.day, b.category, Math.round(b.minutes), b.event_count]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Idempotent per-(resource, day) upsert of a usage snapshot. */
export async function upsertApiMetric(
  resourceId: number,
  day: string,
  tokensIn: number,
  tokensOut: number,
  cost: number
): Promise<void> {
  await query(
    `INSERT INTO api_metrics (resource_id, day, tokens_in, tokens_out, cost)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (resource_id, day) DO UPDATE SET
       tokens_in = EXCLUDED.tokens_in,
       tokens_out = EXCLUDED.tokens_out,
       cost = EXCLUDED.cost,
       timestamp = now()`,
    [resourceId, day, tokensIn, tokensOut, cost]
  );
}
