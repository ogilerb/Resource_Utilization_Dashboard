// Shared telemetry agent core (Node.js, zero runtime dependencies).
//
// Responsibilities:
//   - poll a platform collector on a fixed interval,
//   - POST each datapoint to /api/ingest/compute with the per-agent API key,
//   - buffer-and-retry on network failure so datapoints aren't lost, persisting
//     the pending buffer to disk so a crash/restart keeps unsent points.
//
// NOTE on sleeping laptops: while a machine is asleep the process is suspended,
// so no datapoints are produced (correct — there is no utilization to report).
// Buffering only covers the awake-but-offline case. The server flags the
// resource offline from its `last_seen`, and the dashboard renders the gap.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import os from 'node:os';

const MAX_BUFFER = 5000; // cap pending points (~ hours of data) to bound memory/disk

/**
 * @param {object} opts
 * @param {() => Promise<{cpu_percent:number|null, memory_bytes:number|null}>} opts.collect
 * @param {object} opts.config  { endpoint, apiKey, intervalSeconds, bufferFile }
 */
export function createAgent({ collect, config }) {
  const endpoint = config.endpoint.replace(/\/$/, '') + '/api/ingest/compute';
  const intervalMs = Math.max(1, Number(config.intervalSeconds)) * 1000;
  /** @type {Array<object>} */
  let buffer = [];
  let flushing = false;

  async function loadBuffer() {
    if (!config.bufferFile) return;
    try {
      const raw = await readFile(config.bufferFile, 'utf8');
      buffer = raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .slice(-MAX_BUFFER);
      if (buffer.length) console.log(`[agent] restored ${buffer.length} buffered point(s)`);
    } catch {
      /* no buffer file yet */
    }
  }

  async function persistBuffer() {
    if (!config.bufferFile) return;
    try {
      await mkdir(dirname(config.bufferFile), { recursive: true });
      await writeFile(config.bufferFile, buffer.map((p) => JSON.stringify(p)).join('\n'));
    } catch (err) {
      console.error('[agent] failed to persist buffer', err.message);
    }
  }

  async function post(point) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
      body: JSON.stringify(point),
      signal: AbortSignal.timeout(Math.min(intervalMs, 10_000)),
    });
    if (!res.ok) throw new Error(`ingest ${res.status}: ${await res.text().catch(() => '')}`);
  }

  // Drain the buffer oldest-first; stop on the first failure and keep the rest.
  async function flush() {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    try {
      while (buffer.length > 0) {
        const point = buffer[0];
        await post(point);
        buffer.shift();
      }
      await persistBuffer();
    } catch (err) {
      console.warn(`[agent] flush paused (${err.message}); ${buffer.length} point(s) queued`);
      await persistBuffer();
    } finally {
      flushing = false;
    }
  }

  async function tick() {
    try {
      const metric = await collect();
      metric.timestamp = new Date().toISOString();
      buffer.push(metric);
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      await flush();
    } catch (err) {
      console.error('[agent] tick error', err.message);
    }
  }

  return {
    async start() {
      await loadBuffer();
      console.log(
        `[agent] pushing to ${endpoint} every ${config.intervalSeconds}s ` +
          `(buffer cap ${MAX_BUFFER})`
      );
      // Prime the collector (CPU delta needs a baseline), then run on interval.
      await collect().catch(() => {});
      await tick();
      const timer = setInterval(tick, intervalMs);
      const stop = () => {
        clearInterval(timer);
        persistBuffer().finally(() => process.exit(0));
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    },
  };
}

/**
 * Load agent config: JSON file (path via --config, TELEMETRY_CONFIG env, or a
 * default), with env-var overrides for containerized/systemd deploys.
 */
export async function loadConfig(defaultPath) {
  const argIdx = process.argv.indexOf('--config');
  const path =
    (argIdx >= 0 ? process.argv[argIdx + 1] : undefined) ||
    process.env.TELEMETRY_CONFIG ||
    defaultPath;

  let fileCfg = {};
  try {
    fileCfg = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    console.warn(`[agent] no config file at ${path}; relying on env vars`);
  }

  const cfg = {
    endpoint: process.env.TELEMETRY_ENDPOINT || fileCfg.endpoint,
    apiKey: process.env.TELEMETRY_API_KEY || fileCfg.apiKey,
    intervalSeconds: Number(process.env.TELEMETRY_INTERVAL || fileCfg.intervalSeconds || 15),
    bufferFile: process.env.TELEMETRY_BUFFER || fileCfg.bufferFile,
  };
  if (!cfg.endpoint || !cfg.apiKey) {
    console.error('[agent] endpoint and apiKey are required (config file or env)');
    process.exit(1);
  }
  return cfg;
}

/**
 * Cross-platform CPU% + used-memory collector using only Node's `os` module.
 * CPU% is the average busy fraction across all cores between successive calls,
 * so the first call returns null (no baseline yet).
 */
export function makeOsCollector() {
  function cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      for (const t of Object.values(c.times)) total += t;
      idle += c.times.idle;
    }
    return { idle, total };
  }

  let prev = cpuTimes();

  return async () => {
    const cur = cpuTimes();
    const idleDelta = cur.idle - prev.idle;
    const totalDelta = cur.total - prev.total;
    prev = cur;
    const cpu = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : null;
    return {
      cpu_percent: cpu === null ? null : Math.max(0, Math.min(100, Number(cpu.toFixed(2)))),
      memory_bytes: os.totalmem() - os.freemem(),
    };
  };
}
