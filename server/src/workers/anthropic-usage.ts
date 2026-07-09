import { config } from '../config.js';
import { ensureApiResource, upsertApiMetric } from './upsertResource.js';

/**
 * Pull Claude usage + cost from the Anthropic Admin API and store daily totals.
 *
 * Uses the Usage & Cost Admin endpoints (require an Admin API key, `sk-ant-admin…`):
 *   GET /v1/organizations/usage_report/messages
 *   GET /v1/organizations/cost_report
 * We aggregate token usage and cost per UTC day and upsert idempotently, so
 * re-running the job (or overlapping days) never double-counts.
 *
 * Docs: https://docs.anthropic.com/en/api/administration-api
 */

const API_BASE = 'https://api.anthropic.com/v1/organizations';

interface UsageBucket {
  starting_at: string;
  results: Array<{
    uncached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    input_tokens?: number;
  }>;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      'x-api-key': config.anthropic.adminKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Run the worker for the trailing `days` days (default 2 to catch late data). */
export async function runAnthropicUsage(days = 2): Promise<void> {
  if (!config.anthropic.adminKey) {
    console.log('[anthropic-usage] ANTHROPIC_ADMIN_KEY not set; skipping');
    return;
  }

  const resourceId = await ensureApiResource(config.anthropic.resourceName);
  const startingAt = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  // --- Token usage, bucketed by day ---
  const tokensByDay = new Map<string, { in: number; out: number }>();
  const usageUrl = `${API_BASE}/usage_report/messages?starting_at=${startingAt}T00:00:00Z&bucket_width=1d`;
  const usage = await fetchJson(usageUrl);
  for (const bucket of (usage.data ?? []) as UsageBucket[]) {
    const day = bucket.starting_at.slice(0, 10);
    const agg = tokensByDay.get(day) ?? { in: 0, out: 0 };
    for (const r of bucket.results ?? []) {
      agg.in +=
        (r.input_tokens ?? 0) +
        (r.uncached_input_tokens ?? 0) +
        (r.cache_creation_input_tokens ?? 0) +
        (r.cache_read_input_tokens ?? 0);
      agg.out += r.output_tokens ?? 0;
    }
    tokensByDay.set(day, agg);
  }

  // --- Cost, bucketed by day ---
  const costByDay = new Map<string, number>();
  const costUrl = `${API_BASE}/cost_report?starting_at=${startingAt}T00:00:00Z&bucket_width=1d`;
  const cost = await fetchJson(costUrl);
  for (const bucket of (cost.data ?? []) as Array<{ starting_at: string; results: Array<{ amount?: number }> }>) {
    const day = bucket.starting_at.slice(0, 10);
    const sum = (bucket.results ?? []).reduce((acc, r) => acc + (r.amount ?? 0), 0);
    costByDay.set(day, (costByDay.get(day) ?? 0) + sum);
  }

  const days_ = new Set([...tokensByDay.keys(), ...costByDay.keys()]);
  for (const day of days_) {
    const t = tokensByDay.get(day) ?? { in: 0, out: 0 };
    await upsertApiMetric(resourceId, day, t.in, t.out, costByDay.get(day) ?? 0);
  }
  console.log(`[anthropic-usage] upserted ${days_.size} day(s) for "${config.anthropic.resourceName}"`);
}
