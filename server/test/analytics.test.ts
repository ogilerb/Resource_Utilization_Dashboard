import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import {
  afetch,
  dbAvailable,
  resetDb,
  startTestServer,
  stopTestServer,
  type TestCtx,
} from './helpers.js';

const hasDb = await dbAvailable();

describe('analytics summary', { skip: hasDb ? false : 'no test Postgres reachable' }, () => {
  let ctx: TestCtx;
  let computeId: number;

  before(async () => {
    await resetDb();
    ctx = await startTestServer();
    const c = await afetch(`${ctx.baseUrl}/api/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'analytics-mac', type: 'compute', interval_seconds: 5 }),
    });
    computeId = (await c.json()).resource.id;

    // Current week averages 40% CPU; previous week averages 50%.
    // (a 3-day-ago point sits in now-7d..now; a 10-day-ago point sits in the
    // now-14d..now-7d window.)
    await pool.query(
      `INSERT INTO compute_metrics (resource_id, cpu_percent, memory_bytes, timestamp) VALUES
         ($1, 40, 1000, now() - interval '3 days'),
         ($1, 50, 2000, now() - interval '10 days')`,
      [computeId]
    );
  });

  after(async () => {
    await stopTestServer(ctx);
    await pool.end();
  });

  it('computes week-over-week compute deltas with the right sign', async () => {
    const { resources } = await (await afetch(`${ctx.baseUrl}/api/analytics/summary`)).json();
    const r = resources.find((x: any) => x.resource_id === computeId);
    assert.ok(r, 'compute resource present');
    assert.equal(r.type, 'compute');
    assert.equal(r.metric, 'cpu_percent');
    assert.equal(r.week.current, 40);
    assert.equal(r.week.previous, 50);
    // (40 - 50) / 50 * 100 = -20  → utilization dropped week-over-week.
    assert.ok(Math.abs(r.week.delta_pct - -20) < 1e-6);
    // Secondary metric (memory) is present too.
    assert.equal(r.secondary.metric, 'memory_bytes');
    assert.equal(r.secondary.week.current, 1000);
  });

  it('averages seven_day usage by calendar week, excluding other windows', async () => {
    const usage = await (
      await afetch(`${ctx.baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude-usage', type: 'usage', interval_seconds: 900 }),
      })
    ).json();
    const usageId = usage.resource.id;
    // This week: two seven_day samples (avg 50%) plus a five_hour sample that
    // must be ignored. A prior week (8 days ago) forms a second bucket.
    await pool.query(
      `INSERT INTO usage_metrics (resource_id, window_kind, utilization, timestamp) VALUES
         ($1, 'seven_day', 40, now()),
         ($1, 'seven_day', 60, now()),
         ($1, 'five_hour', 100, now()),
         ($1, 'seven_day', 20, now() - interval '8 days')`,
      [usageId]
    );
    const { weeks } = await (
      await afetch(`${ctx.baseUrl}/api/analytics/usage-weekly?resource_id=${usageId}`)
    ).json();
    assert.ok(weeks.length >= 2, 'has a bucket for this week and a prior week');
    const current = weeks[weeks.length - 1]; // ascending → current week is last
    assert.equal(current.avg_utilization, 50);
    assert.equal(current.max_utilization, 60);
    assert.equal(current.sample_count, 2); // five_hour excluded
    assert.ok(
      weeks.some((w: any) => w.avg_utilization === 20),
      'prior-week bucket present'
    );
  });

  it('returns delta_pct null when the previous period has no data', async () => {
    // A fresh resource with only a current-week point → no previous baseline.
    const fresh = await (
      await afetch(`${ctx.baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'fresh-mac', type: 'compute', interval_seconds: 5 }),
      })
    ).json();
    await pool.query(
      `INSERT INTO compute_metrics (resource_id, cpu_percent, timestamp)
       VALUES ($1, 30, now() - interval '1 day')`,
      [fresh.resource.id]
    );
    const { resources } = await (await afetch(`${ctx.baseUrl}/api/analytics/summary`)).json();
    const r = resources.find((x: any) => x.resource_id === fresh.resource.id);
    assert.equal(r.week.current, 30);
    assert.equal(r.week.previous, null);
    assert.equal(r.week.delta_pct, null);
  });
});
