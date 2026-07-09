import { config } from '../config.js';
import { ensureApiResource, upsertApiMetric } from './upsertResource.js';

/**
 * Pull Gemini (Google Cloud) usage + cost from the BigQuery billing export.
 *
 * Setup (one-time, in Google Cloud):
 *   1. Enable "Detailed usage cost" BigQuery billing export.
 *   2. Point GEMINI_BILLING_TABLE at the export table, e.g.
 *      `my-project.billing.gcp_billing_export_resource_v1_XXXXXX`.
 *   3. Provide a service-account key via GOOGLE_APPLICATION_CREDENTIALS.
 *
 * @google-cloud/bigquery is an OPTIONAL dependency — the worker no-ops if it
 * isn't installed or the export table isn't configured, so the server runs fine
 * without Google credentials.
 *
 * Token counts aren't in the billing export; cost is authoritative there, and
 * per-model token usage (if needed) can be pushed separately via /api/ingest/api.
 */
export async function runGeminiBilling(days = 3): Promise<void> {
  if (!config.gemini.billingTable) {
    console.log('[gemini-billing] GEMINI_BILLING_TABLE not set; skipping');
    return;
  }

  let BigQuery: any;
  try {
    // Indirect specifier so TypeScript treats this as a runtime-only optional dep.
    const mod = '@google-cloud/bigquery';
    ({ BigQuery } = await import(/* @vite-ignore */ mod));
  } catch {
    console.log('[gemini-billing] @google-cloud/bigquery not installed; skipping');
    return;
  }

  const resourceId = await ensureApiResource(config.gemini.resourceName);
  const bq = new BigQuery(
    config.gemini.credentials ? { keyFilename: config.gemini.credentials } : {}
  );

  // Sum cost per usage day for Generative Language / Vertex AI services.
  const sql = `
    SELECT
      DATE(usage_start_time) AS day,
      SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost
    FROM \`${config.gemini.billingTable}\`
    WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)
      AND (LOWER(service.description) LIKE '%generative language%'
        OR LOWER(service.description) LIKE '%vertex ai%'
        OR LOWER(sku.description) LIKE '%gemini%')
    GROUP BY day
    ORDER BY day
  `;

  const [rows] = await bq.query({ query: sql, params: { days } });
  for (const row of rows as Array<{ day: { value: string } | string; net_cost: number }>) {
    const day = typeof row.day === 'string' ? row.day : row.day.value;
    // Billing export carries no token split; store cost only.
    await upsertApiMetric(resourceId, day, 0, 0, Number(row.net_cost ?? 0));
  }
  console.log(`[gemini-billing] upserted ${rows.length} day(s) for "${config.gemini.resourceName}"`);
}
