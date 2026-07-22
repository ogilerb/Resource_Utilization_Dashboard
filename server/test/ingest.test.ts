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

describe('ingest', { skip: hasDb ? false : 'no test Postgres reachable' }, () => {
  let ctx: TestCtx;
  let computeKey: string;
  let apiKey: string;
  let computeId: number;

  before(async () => {
    await resetDb();
    ctx = await startTestServer();

    const c = await afetch(`${ctx.baseUrl}/api/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test-mac', type: 'compute', interval_seconds: 5 }),
    });
    const cJson = await c.json();
    computeKey = cJson.api_key;
    computeId = cJson.resource.id;

    const a = await afetch(`${ctx.baseUrl}/api/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test-claude', type: 'api' }),
    });
    apiKey = (await a.json()).api_key;
  });

  after(async () => {
    await stopTestServer(ctx);
    await pool.end();
  });

  it('rejects ingest without an API key', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/ingest/compute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cpu_percent: 10, memory_bytes: 100 }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects an invalid API key', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/ingest/compute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tk_bogus' },
      body: JSON.stringify({ cpu_percent: 10, memory_bytes: 100 }),
    });
    assert.equal(res.status, 401);
  });

  it('accepts a valid compute datapoint and persists it', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/ingest/compute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': computeKey },
      body: JSON.stringify({ cpu_percent: 42.5, memory_bytes: 2048 }),
    });
    assert.equal(res.status, 202);
    const { rows } = await pool.query(
      'SELECT cpu_percent, memory_bytes FROM compute_metrics WHERE resource_id = $1',
      [computeId]
    );
    assert.equal(rows.length, 1);
    assert.equal(Math.round(rows[0].cpu_percent * 10) / 10, 42.5);
    assert.equal(rows[0].memory_bytes, 2048);
  });

  it('rejects out-of-range cpu_percent', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/ingest/compute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': computeKey },
      body: JSON.stringify({ cpu_percent: 250 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a compute payload sent with an api-type key', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/ingest/compute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ cpu_percent: 10 }),
    });
    assert.equal(res.status, 400);
  });

  it('upserts api usage idempotently per (resource, day)', async () => {
    const body = { day: '2026-07-01', tokens_in: 100, tokens_out: 50, cost: 1.25 };
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${ctx.baseUrl}/api/ingest/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 202);
    }
    const { rows } = await pool.query(
      "SELECT tokens_in, cost FROM api_metrics WHERE day = '2026-07-01'"
    );
    assert.equal(rows.length, 1, 'no duplicate row for the same day');
    assert.equal(rows[0].tokens_in, 100);
  });

  it('accepts usage gauge samples for a usage-type resource and queries them back', async () => {
    const u = await (
      await afetch(`${ctx.baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claude-pro', type: 'usage', interval_seconds: 900 }),
      })
    ).json();

    const res = await fetch(`${ctx.baseUrl}/api/ingest/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': u.api_key },
      body: JSON.stringify({
        samples: [
          { window: 'seven_day', utilization: 9, resets_at: '2026-07-17T04:00:00.490212+00:00' },
          { window: 'five_hour', utilization: 11, resets_at: '2026-07-14T02:00:00+00:00' },
          { window: 'extra_spend', utilization: 45, raw: { currency: 'CAD' } },
        ],
      }),
    });
    assert.equal(res.status, 202);

    const q = await (
      await afetch(`${ctx.baseUrl}/api/metrics/usage?resource_id=${u.resource.id}`)
    ).json();
    assert.equal(q.points.length, 3);
    const weekly = q.points.find((p: any) => p.window_kind === 'seven_day');
    assert.equal(weekly.utilization, 9);
    assert.ok(weekly.resets_at);

    // Rejects usage push with a compute key.
    const bad = await fetch(`${ctx.baseUrl}/api/ingest/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': computeKey },
      body: JSON.stringify({ samples: [{ window: 'seven_day', utilization: 1 }] }),
    });
    assert.equal(bad.status, 400);
  });

  it('increments api usage when increment=true', async () => {
    const body = { day: '2026-07-02', tokens_in: 10, tokens_out: 5, cost: 0.1, increment: true };
    for (let i = 0; i < 3; i++) {
      await fetch(`${ctx.baseUrl}/api/ingest/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
      });
    }
    const { rows } = await pool.query(
      "SELECT tokens_in FROM api_metrics WHERE day = '2026-07-02'"
    );
    assert.equal(rows[0].tokens_in, 30);
  });
});
