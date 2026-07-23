// Pacing auto-run agent (Node.js, zero runtime dependencies).
//
// Reads your Claude subscription usage from the telemetry dashboard's read API
// and, when you're behind your weekly pace *and* have session headroom, runs one
// of the tasks YOU define through the subscription-logged-in `claude` CLI. Saves
// the task output to a file. Stops well before the weekly limit / 5-hour session
// cap so it never spills into overage credits.
//
// Unlike the telemetry agents in this repo, this one does not push data — it only
// READS pace (Authorization: Bearer <DASHBOARD_TOKEN>) and executes locally. It
// must run where you're logged into the Claude subscription (your Mac), because
// only that surface spends the subscription rather than pay-per-token credits.
//
// Guardrails, in order, per provider per cycle:
//   freshness  — ignore stale gauges (browser/extension not reporting)
//   pace       — only act when utilization < weekElapsed - margin
//   headroom   — stop below weeklyCap / fiveHourCap, and if extra_spend is active
//   cooldown   — >= one gauge-refresh cycle between runs (overshoot guard)
// See docs/claude-pacing-agent.md for the full rationale.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function log(msg) {
  console.log(`[pacing] ${new Date().toISOString()} ${msg}`);
}

function expandHome(p) {
  return p.startsWith('~') ? os.homedir() + p.slice(1) : p;
}

// Replace {key} placeholders from `vars`. Leaves unknown placeholders intact.
function interpolate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// ---- config / state -------------------------------------------------------

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadConfig() {
  const path = argValue('--config') || process.env.PACING_CONFIG || './config.json';
  const cfg = await loadJson(path).catch((e) => {
    console.error(`[pacing] cannot read config at ${path}: ${e.message}`);
    process.exit(1);
  });

  cfg.dashboard = cfg.dashboard || {};
  cfg.dashboard.endpoint = process.env.PACING_DASHBOARD_ENDPOINT || cfg.dashboard.endpoint;
  cfg.dashboard.token = process.env.PACING_DASHBOARD_TOKEN || cfg.dashboard.token;
  if (!cfg.dashboard.endpoint || !cfg.dashboard.token) {
    console.error('[pacing] dashboard.endpoint and dashboard.token are required');
    process.exit(1);
  }

  cfg.checkIntervalSeconds = Number(cfg.checkIntervalSeconds) || 600;
  cfg.outputDir = cfg.outputDir || '~/pacing-output';
  cfg.stateFile = cfg.stateFile || './state.json';
  cfg.dryRun = cfg.dryRun || process.argv.includes('--dry-run');

  // Tasks live in a separate file (tasksFile) or inline (tasks).
  if (!cfg.tasks) {
    const tasksPath = cfg.tasksFile || './tasks.json';
    const loaded = await loadJson(tasksPath).catch((e) => {
      console.error(`[pacing] cannot read tasks at ${tasksPath}: ${e.message}`);
      process.exit(1);
    });
    cfg.tasks = Array.isArray(loaded) ? loaded : loaded.tasks || [];
  }
  if (!cfg.providers || Object.keys(cfg.providers).length === 0) {
    console.error('[pacing] at least one provider must be configured');
    process.exit(1);
  }
  return cfg;
}

// Per-task and per-provider last-run timestamps, so cooldowns survive restarts.
async function loadState(path) {
  return loadJson(path).catch(() => ({ taskRuns: {}, providerRuns: {} }));
}

async function saveState(path, state) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[pacing] failed to persist state: ${err.message}`);
  }
}

// ---- dashboard reads ------------------------------------------------------

function makeApi(cfg) {
  const base = cfg.dashboard.endpoint.replace(/\/$/, '');
  const headers = { accept: 'application/json', authorization: `Bearer ${cfg.dashboard.token}` };

  async function getJson(pathAndQuery) {
    const res = await fetch(base + pathAndQuery, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${res.status} on ${pathAndQuery.split('?')[0]}`);
    return res.json();
  }

  return {
    listResources: () => getJson('/api/resources').then((d) => d.resources || []),
    // Latest sample per window_kind for a resource (points come back ascending).
    async latestGauges(resourceId) {
      const to = new Date();
      const from = new Date(to.getTime() - 2 * 60 * 60 * 1000); // 2h lookback
      const d = await getJson(
        `/api/metrics/usage?resource_id=${resourceId}` +
          `&from=${from.toISOString()}&to=${to.toISOString()}&limit=5000`
      );
      const latest = new Map();
      for (const p of d.points || []) latest.set(p.window_kind, p);
      return latest;
    },
  };
}

// ---- pace math ------------------------------------------------------------

// How far through the 7-day window we are, from the seven_day gauge's reset time.
// Mirrors dashboard/src/app/components/usage-panel.component.ts.
function weekElapsedPct(sevenDay) {
  if (!sevenDay?.resets_at) return null;
  const resets = new Date(sevenDay.resets_at).getTime();
  if (!Number.isFinite(resets)) return null;
  const start = resets - WEEK_MS;
  return Math.max(0, Math.min(100, ((Date.now() - start) / WEEK_MS) * 100));
}

function newestTimestampMs(latest) {
  let newest = 0;
  for (const p of latest.values()) {
    const t = new Date(p.timestamp).getTime();
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

// ---- task execution -------------------------------------------------------

function runCommand(argv, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${err.trim().slice(0, 400)}`));
    });
  });
}

async function runTask(cfg, provider, task) {
  const now = new Date();
  const vars = {
    date: now.toISOString().slice(0, 10),
    datetime: now.toISOString().replace(/[:T]/g, '-').slice(0, 16),
    id: task.id,
    provider: task.provider,
    outputDir: expandHome(cfg.outputDir),
  };
  const promptText = interpolate(task.prompt, vars);
  const argv = provider.run.map((a) => a.split('{prompt}').join(promptText));
  log(`running task "${task.id}" via ${argv[0]} …`);
  const stdout = await runCommand(argv, task.timeoutSeconds || provider.timeoutSeconds || 900);

  const outPath = expandHome(interpolate(task.output, vars));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `# ${task.id} — ${now.toISOString()}\n\n${stdout}`);
  log(`task "${task.id}" done → ${outPath} (${stdout.length} chars)`);
  return outPath;
}

// ---- evaluation -----------------------------------------------------------

const num = (v, d) => (typeof v === 'number' ? v : d);

function findResource(resources, name) {
  const wanted = name.toLowerCase();
  const usage = resources.filter((r) => r.type === 'usage');
  const exact = usage.filter((r) => r.name.toLowerCase() === wanted);
  const matches = exact.length ? exact : usage.filter((r) => r.name.toLowerCase().includes(wanted));
  if (matches.length === 0) return { resource: null, reason: `no usage resource matching "${name}"` };
  if (matches.length > 1)
    return { resource: null, reason: `"${name}" is ambiguous (${matches.map((m) => m.name).join(', ')})` };
  return { resource: matches[0] };
}

// Returns the first task for this provider that's off its per-task cooldown.
function nextDueTask(cfg, providerName, state) {
  const now = Date.now();
  for (const task of cfg.tasks) {
    if (task.provider !== providerName) continue;
    const last = state.taskRuns[task.id];
    const cooldownMs = (num(task.cooldownMinutes, 0)) * 60_000;
    if (!last || now - new Date(last).getTime() >= cooldownMs) return task;
  }
  return null;
}

async function evaluateProvider(cfg, api, state, providerName, provider, resources) {
  const capW = num(provider.weeklyCapPct, 85);
  const capH = num(provider.fiveHourCapPct, 80);
  const margin = num(provider.paceMarginPct, 10);
  const maxStale = num(provider.maxStaleMinutes, 40);
  const cooldownMin = num(provider.postRunCooldownMinutes, 20);

  const { resource, reason } = findResource(resources, provider.resourceName);
  if (!resource) return log(`[${providerName}] skip — ${reason}`);

  const latest = await api.latestGauges(resource.id);
  if (latest.size === 0) return log(`[${providerName}] skip — no recent gauges`);

  const staleMin = (Date.now() - newestTimestampMs(latest)) / 60_000;
  if (staleMin > maxStale)
    return log(`[${providerName}] skip — stale data (${staleMin.toFixed(0)}m old > ${maxStale}m)`);

  const seven = latest.get('seven_day');
  const elapsed = weekElapsedPct(seven);
  if (seven == null || elapsed == null)
    return log(`[${providerName}] skip — no seven_day gauge / reset time; can't pace`);

  const weekly = seven.utilization;
  const fiveHour = latest.get('five_hour')?.utilization ?? 0;
  const extra = latest.get('extra_spend');
  const extraActive = !!extra && num(extra.utilization, 0) > 0;
  const behindBy = elapsed - margin - weekly;

  const status =
    `[${providerName}] weekly ${weekly.toFixed(0)}% vs pace ${elapsed.toFixed(0)}% ` +
    `(margin ${margin}) · 5h ${fiveHour.toFixed(0)}%` +
    (extraActive ? ` · extra_spend ${num(extra.utilization, 0).toFixed(0)}%` : '');

  // Guardrails.
  if (weekly >= elapsed - margin) return log(`${status} → on pace, nothing to do`);
  if (weekly >= capW) return log(`${status} → at weekly cap ${capW}%, hold`);
  if (fiveHour >= capH) return log(`${status} → 5-hour session at cap ${capH}%, hold`);
  if (provider.stopIfExtraSpend !== false && extraActive)
    return log(`${status} → extra_spend active, hold (never spend credits)`);

  const lastRun = state.providerRuns[providerName];
  if (lastRun && Date.now() - new Date(lastRun).getTime() < cooldownMin * 60_000) {
    const waited = (Date.now() - new Date(lastRun).getTime()) / 60_000;
    return log(`${status} → behind ${behindBy.toFixed(0)}pts, cooling down (${waited.toFixed(0)}/${cooldownMin}m)`);
  }

  const task = nextDueTask(cfg, providerName, state);
  if (!task) return log(`${status} → behind ${behindBy.toFixed(0)}pts, but no task is due`);

  if (cfg.dryRun) return log(`${status} → behind ${behindBy.toFixed(0)}pts → WOULD run task "${task.id}" (dry-run)`);

  log(`${status} → behind ${behindBy.toFixed(0)}pts → run task "${task.id}"`);
  const when = new Date().toISOString();
  try {
    await runTask(cfg, provider, task);
    state.taskRuns[task.id] = when;
    state.providerRuns[providerName] = when;
    await saveState(cfg.stateFile, state);
  } catch (err) {
    // Record the attempt so a failing task doesn't hot-loop; cooldown still applies.
    state.providerRuns[providerName] = when;
    await saveState(cfg.stateFile, state);
    log(`[${providerName}] task "${task.id}" failed: ${err.message}`);
  }
}

// ---- main loop ------------------------------------------------------------

async function main() {
  const cfg = await loadConfig();
  const api = makeApi(cfg);
  const state = await loadState(cfg.stateFile);

  log(
    `watching ${Object.keys(cfg.providers).join(', ')} every ${cfg.checkIntervalSeconds}s ` +
      `· ${cfg.tasks.length} task(s)${cfg.dryRun ? ' · DRY RUN' : ''}`
  );

  let busy = false;
  async function tick() {
    if (busy) return; // a long task run is still in flight; skip this cycle
    busy = true;
    try {
      const resources = await api.listResources();
      for (const [name, provider] of Object.entries(cfg.providers)) {
        try {
          await evaluateProvider(cfg, api, state, name, provider, resources);
        } catch (err) {
          log(`[${name}] evaluation error: ${err.message}`);
        }
      }
    } catch (err) {
      log(`tick error: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  await tick();
  const timer = setInterval(tick, cfg.checkIntervalSeconds * 1000);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(`[pacing] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
