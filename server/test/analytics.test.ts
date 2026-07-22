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

  it('splits seven_day usage into one curve per reset cycle, excluding other windows', async () => {
    const usage = await (
      await afetch(`${ctx.baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude-usage', type: 'usage', interval_seconds: 900 }),
      })
    ).json();
    const usageId = usage.resource.id;
    // Two reset cycles (distinct resets_at). cycle_start = resets_at - 7d, so the
    // current cycle (reset 5 days out) starts 2 days ago; its two seven_day
    // samples land at day 0 and day 3. A five_hour sample must be ignored, and a
    // prior cycle (reset a week earlier) forms a second overlaid curve.
    await pool.query(
      `INSERT INTO usage_metrics (resource_id, window_kind, utilization, resets_at, timestamp) VALUES
         ($1, 'seven_day', 30, now() + interval '5 days', now() - interval '2 days'),
         ($1, 'seven_day', 70, now() + interval '5 days', now() + interval '1 day'),
         ($1, 'five_hour', 99, now() + interval '5 days', now()),
         ($1, 'seven_day', 45, now() - interval '2 days', now() - interval '9 days')`,
      [usageId]
    );
    const { weeks } = await (
      await afetch(`${ctx.baseUrl}/api/analytics/usage-weekly?resource_id=${usageId}`)
    ).json();
    assert.equal(weeks.length, 2, 'one curve per reset cycle');
    const current = weeks[weeks.length - 1]; // ascending by cycle_start → current last
    assert.equal(current.sample_count, 2); // five_hour excluded
    // Points are ordered by time and carry days-since-reset (cycle_start = resets_at - 7d).
    assert.equal(current.points.length, 2);
    assert.equal(current.points[0].u, 30);
    assert.equal(current.points[1].u, 70);
    assert.ok(Math.abs(current.points[0].t - 0) < 0.01, `t≈0, got ${current.points[0].t}`);
    assert.ok(Math.abs(current.points[1].t - 3) < 0.01, `t≈3, got ${current.points[1].t}`);
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
