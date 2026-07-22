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

describe('resources + metrics', { skip: hasDb ? false : 'no test Postgres reachable' }, () => {
  let ctx: TestCtx;
  let computeKey: string;
  let computeId: number;

  before(async () => {
    await resetDb();
    ctx = await startTestServer();
    const c = await afetch(`${ctx.baseUrl}/api/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'metrics-mac', type: 'compute', interval_seconds: 5 }),
    });
    const j = await c.json();
    computeKey = j.api_key;
    computeId = j.resource.id;
  });

  after(async () => {
    await stopTestServer(ctx);
    await pool.end();
  });

  it('lists resources with an online flag driven by last_seen', async () => {
    // No data yet → offline.
    let list = await (await afetch(`${ctx.baseUrl}/api/resources`)).json();
    let r = list.resources.find((x: any) => x.id === computeId);
    assert.equal(r.online, false);
    assert.equal(r.last_seen, null);

    // Ingest a point → online, last_seen populated.
    await fetch(`${ctx.baseUrl}/api/ingest/compute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': computeKey },
      body: JSON.stringify({ cpu_percent: 20, memory_bytes: 1000 }),
    });
    list = await (await afetch(`${ctx.baseUrl}/api/resources`)).json();
    r = list.resources.find((x: any) => x.id === computeId);
    assert.equal(r.online, true);
    assert.ok(r.last_seen);
  });

  it('flags a resource offline when its last point is older than interval*multiplier', async () => {
    // Insert a stale point (interval 5s * multiplier 3 = 15s window; use 1h ago).
    await pool.query(
      `INSERT INTO compute_metrics (resource_id, cpu_percent, memory_bytes, timestamp)
       VALUES ($1, 5, 500, now() - interval '1 hour')`,
      [computeId]
    );
    // Also register a fresh resource with no recent data.
    const stale = await (
      await afetch(`${ctx.baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'stale-mac', type: 'compute', interval_seconds: 5 }),
      })
    ).json();
    await pool.query(
      `INSERT INTO compute_metrics (resource_id, cpu_percent, timestamp)
       VALUES ($1, 5, now() - interval '1 hour')`,
      [stale.resource.id]
    );
    const list = await (await afetch(`${ctx.baseUrl}/api/resources`)).json();
    const r = list.resources.find((x: any) => x.id === stale.resource.id);
    assert.equal(r.online, false);
    assert.ok(r.last_seen, 'last_seen still reported even when offline');
  });

  it('returns a compute time-series ordered ascending, filtered by range', async () => {
    await pool.query('TRUNCATE compute_metrics');
    const base = Date.parse('2026-07-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO compute_metrics (resource_id, cpu_percent, timestamp)
         VALUES ($1, $2, $3)`,
        [computeId, i * 10, new Date(base + i * 60_000).toISOString()]
      );
    }
    const url = `${ctx.baseUrl}/api/metrics/compute?resource_id=${computeId}&from=2026-07-01T00:01:00Z&to=2026-07-01T00:03:00Z`;
    const { points } = await (await afetch(url)).json();
    assert.equal(points.length, 3);
    assert.ok(points[0].timestamp < points[1].timestamp);
    assert.equal(points[0].cpu_percent, 10);
  });

  it('averages raw samples into per-hour buckets', async () => {
    await pool.query('TRUNCATE compute_metrics');
    // Two samples in the 00:00 hour (avg 15%) and two in the 01:00 hour (avg 35%).
    const rows: [number, string][] = [
      [10, '2026-07-01T00:05:00Z'],
      [20, '2026-07-01T00:45:00Z'],
      [30, '2026-07-01T01:15:00Z'],
      [40, '2026-07-01T01:50:00Z'],
    ];
    for (const [cpu, ts] of rows) {
      await pool.query(
        `INSERT INTO compute_metrics (resource_id, cpu_percent, memory_bytes, timestamp)
         VALUES ($1, $2, 1000, $3)`,
        [computeId, cpu, ts]
      );
    }
    const url = `${ctx.baseUrl}/api/metrics/compute/bucketed?resource_id=${computeId}&bucket=hour&from=2026-07-01T00:00:00Z&to=2026-07-01T02:00:00Z`;
    const { points } = await (await afetch(url)).json();
    assert.equal(points.length, 2);
    assert.equal(new Date(points[0].timestamp).toISOString(), '2026-07-01T00:00:00.000Z');
    assert.equal(points[0].cpu_percent_avg, 15);
    assert.equal(points[0].cpu_percent_max, 20);
    assert.equal(points[0].sample_count, 2);
    assert.equal(points[1].cpu_percent_avg, 35);
  });

  it('rejects a bucketed request with an invalid bucket', async () => {
    const res = await afetch(
      `${ctx.baseUrl}/api/metrics/compute/bucketed?resource_id=${computeId}&bucket=minute`
    );
    assert.equal(res.status, 400);
  });

  it('validates query params', async () => {
    const res = await afetch(`${ctx.baseUrl}/api/metrics/compute?resource_id=notanumber`);
    assert.equal(res.status, 400);
  });

  it('exposes a healthz endpoint', async () => {
    const res = await fetch(`${ctx.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, 'ok');
  });

  it('rejects read endpoints without the dashboard token', async () => {
    // No Authorization header → gated.
    assert.equal((await fetch(`${ctx.baseUrl}/api/resources`)).status, 401);
    assert.equal(
      (await fetch(`${ctx.baseUrl}/api/metrics/compute?resource_id=${computeId}`)).status,
      401
    );
    // Wrong token → still gated.
    const bad = await fetch(`${ctx.baseUrl}/api/resources`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(bad.status, 401);
  });
});
