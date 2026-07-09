import { query } from '../db/pool.js';
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
