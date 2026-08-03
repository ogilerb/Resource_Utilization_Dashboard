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
// Two task shapes (see tasks.json): a *fixed* task runs one static prompt each
// time; a *chained* task ("chain": true) pursues a standing mission where each
// turn does a chunk of work AND writes the prompt for the next turn, carrying a
// journal of state forward. Chained turns run confined to their own workspace
// directory with no network (see SANDBOX_SETTINGS), and stop on the model's
// done flag or a maxTurns cap.
//
// Guardrails, in order, per provider per cycle:
//   freshness  — ignore stale gauges (browser/extension not reporting)
//   pace       — only act when utilization < weekElapsed - margin
//   headroom   — stop below weeklyCap / fiveHourCap, and if extra_spend is active
//   cooldown   — >= one gauge-refresh cycle between runs (overshoot guard)
// See docs/claude-pacing-agent.md for the full rationale.

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  cfg.stateFile = expandHome(cfg.stateFile || './state.json');
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
  const state = await loadJson(path).catch(() => ({}));
  state.taskRuns = state.taskRuns || {};
  state.providerRuns = state.providerRuns || {};
  state.chains = state.chains || {};
  return state;
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

function runCommand(argv, timeoutSeconds, cwd) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
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

function baseVars(cfg, task, now) {
  return {
    date: now.toISOString().slice(0, 10),
    datetime: now.toISOString().replace(/[:T]/g, '-').slice(0, 16),
    id: task.id,
    provider: task.provider,
    outputDir: expandHome(cfg.outputDir),
  };
}

async function runTask(cfg, provider, task, state) {
  return task.chain ? runChainTask(cfg, provider, task, state) : runFixedTask(cfg, provider, task);
}

// A fixed task: one static prompt, saved verbatim. Original behaviour.
async function runFixedTask(cfg, provider, task) {
  const now = new Date();
  const vars = baseVars(cfg, task, now);
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

// ---- chained (self-continuing) tasks --------------------------------------

const DEFAULT_MAX_TURNS = 100;
const DEFAULT_WORKSPACE = '{outputDir}/{id}-workspace';
const DEFAULT_CHAIN_OUTPUT = '{outputDir}/{id}-turn{turn}-{datetime}.md';

// The confinement boundary for a chained task, written into <workDir>/.claude/
// settings.json. It keeps every turn inside its own directory with no network:
//   - defaultMode acceptEdits  → in-workspace file edits auto-run unattended;
//                                writes outside the cwd still need approval (denied here).
//   - autoAllowBashIfSandboxed → bash auto-runs *only* when it can be OS-sandboxed;
//                                anything needing network / outside access fails closed.
//   - sandbox.network (no allowedDomains) → no outbound internet.
//   - deny WebFetch/WebSearch  → no network via built-in tools either.
// Written only if absent, so hand-edits to widen the boundary stick.
const SANDBOX_SETTINGS = JSON.stringify(
  {
    permissions: { defaultMode: 'acceptEdits', deny: ['WebFetch', 'WebSearch'] },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowUnixSockets: [], allowLocalBinding: false, allowedDomains: [] },
    },
  },
  null,
  2
);

// Seed (or refresh) the persisted chain state for a task. mission is refreshed
// from the task each run so edits to tasks.json take effect; nextPrompt/journal/
// turn carry the accumulated state and are only seeded when missing.
function ensureChain(state, task) {
  state.chains = state.chains || {};
  let ch = state.chains[task.id];
  if (!ch) {
    ch = {
      mission: task.mission || '',
      nextPrompt: task.seedPrompt || task.prompt || '',
      journal: '',
      turn: 0,
      done: false,
      updatedAt: null,
    };
    state.chains[task.id] = ch;
  }
  ch.mission = task.mission || ch.mission;
  return ch;
}

// Ensure the workspace exists and carries its confinement settings (idempotent).
async function ensureWorkspace(workDir) {
  const settingsPath = join(workDir, '.claude', 'settings.json');
  await mkdir(dirname(settingsPath), { recursive: true });
  try {
    await readFile(settingsPath); // leave any existing (possibly hand-tuned) file alone
  } catch {
    await writeFile(settingsPath, SANDBOX_SETTINGS);
  }
}

// The wrapper prompt for one turn — mission + journal + this turn's instruction,
// plus the contract for emitting the next turn's prompt.
function buildChainPrompt({ mission, turn, journal, nextPrompt, workDir }) {
  return [
    `MISSION (fixed): ${mission}`,
    '',
    `You are on turn ${turn} of an ongoing, autonomous effort toward that mission. Each turn is a`,
    `fresh session with NO memory of previous turns — your only continuity is the JOURNAL below and`,
    `the files already in your working directory (${workDir}), which is the ONLY place you can read`,
    `or write. You have no network access; commands that reach outside this directory or the internet`,
    `will be denied, so don't rely on them.`,
    '',
    'JOURNAL (state so far):',
    journal && journal.trim() ? journal.trim() : '(empty — this is turn 1)',
    '',
    'THIS TURN — do exactly this:',
    nextPrompt,
    '',
    'Rules:',
    '- Make concrete, durable progress: create/modify real files in your working directory, not just plans.',
    "- Take the smallest next step that moves the mission forward; don't try to do everything at once.",
    '- End your reply with a fenced code block tagged `pacing-next` containing ONLY minified JSON:',
    '    {"done": <bool>, "next_prompt": "<the exact, self-contained instruction the NEXT turn should run>", "journal": "<updated running summary, <=200 words: what exists now, key decisions, what is left, blockers>"}',
    '- next_prompt must stand alone: the next turn sees only the mission, the journal, and next_prompt.',
    '- Set done=true only when the mission is genuinely achieved.',
  ].join('\n');
}

// Pull the last ```pacing-next block and parse its JSON. Only strips the block
// from the artifact on a clean parse, so a malformed block stays visible for
// debugging. reason distinguishes "no block" from "bad JSON" for logging.
function parseContinuation(stdout) {
  const re = /```pacing-next\s*\n?([\s\S]*?)```/g;
  let m;
  let raw = null;
  let start = -1;
  let full = null;
  while ((m = re.exec(stdout)) !== null) {
    raw = m[1];
    start = m.index;
    full = m[0];
  }
  if (raw == null) return { body: stdout.trim(), cont: null, reason: 'missing' };
  let cont;
  try {
    cont = JSON.parse(raw.trim());
  } catch {
    return { body: stdout.trim(), cont: null, reason: 'invalid' };
  }
  const body = (stdout.slice(0, start) + stdout.slice(start + full.length)).trim();
  return { body, cont, reason: 'ok' };
}

async function runChainTask(cfg, provider, task, state) {
  const now = new Date();
  const iso = now.toISOString();
  const ch = ensureChain(state, task);
  const turn = num(ch.turn, 0) + 1;

  const vars = baseVars(cfg, task, now);
  const workDir = expandHome(interpolate(task.workspace || DEFAULT_WORKSPACE, vars));
  vars.turn = turn;
  vars.workDir = workDir;

  await ensureWorkspace(workDir);

  const promptText = buildChainPrompt({
    mission: ch.mission,
    turn,
    journal: ch.journal,
    nextPrompt: ch.nextPrompt,
    workDir,
  });
  const argv = provider.run.map((a) => a.split('{prompt}').join(promptText));
  log(`running chain "${task.id}" turn ${turn} via ${argv[0]} in ${workDir} …`);
  const stdout = await runCommand(argv, task.timeoutSeconds || provider.timeoutSeconds || 900, workDir);

  const { body, cont, reason } = parseContinuation(stdout);

  // Save this turn's narration artifact.
  const outPath = expandHome(interpolate(task.output || DEFAULT_CHAIN_OUTPUT, vars));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `# ${task.id} — turn ${turn} — ${iso}\n\n${body}`);

  // Advance chain state. On a clean parse, adopt the model's next_prompt/journal/
  // done. Otherwise keep the current nextPrompt so the next turn retries the step.
  ch.turn = turn;
  ch.updatedAt = iso;
  if (cont) {
    if (typeof cont.next_prompt === 'string' && cont.next_prompt.trim()) ch.nextPrompt = cont.next_prompt.trim();
    if (typeof cont.journal === 'string') ch.journal = cont.journal.trim();
    ch.done = !!cont.done;
  } else {
    log(`chain "${task.id}" turn ${turn}: no valid pacing-next block (${reason}) — keeping previous next_prompt`);
  }

  // Append to the human-readable journal so the arc is easy to follow.
  const journalPath = expandHome(interpolate('{outputDir}/{id}-journal.md', vars));
  const note = cont
    ? `## turn ${turn} — ${iso}${ch.done ? ' — ✅ mission complete' : ''}\n\n${ch.journal || '(no summary)'}\n\n**Next:** ${ch.nextPrompt}\n\n`
    : `## turn ${turn} — ${iso} — ⚠️ no pacing-next block (${reason})\n\nSee ${outPath}. Retrying the same step next turn.\n\n`;
  await appendFile(journalPath, note).catch((e) => log(`chain "${task.id}": journal append failed: ${e.message}`));

  log(
    `chain "${task.id}" turn ${turn} done → ${outPath} (${body.length} chars)` +
      (ch.done ? ' · mission marked complete' : '')
  );
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
// A chained task is also skipped once its mission is done or it hits maxTurns.
function nextDueTask(cfg, providerName, state) {
  const now = Date.now();
  for (const task of cfg.tasks) {
    if (task.provider !== providerName) continue;
    if (task.chain) {
      const ch = state.chains[task.id];
      if (ch?.done) continue;
      if (ch && num(ch.turn, 0) >= num(task.maxTurns, DEFAULT_MAX_TURNS)) continue;
    }
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

  const taskLabel = task.chain
    ? `chain "${task.id}" turn ${num(state.chains[task.id]?.turn, 0) + 1}`
    : `task "${task.id}"`;
  if (cfg.dryRun) return log(`${status} → behind ${behindBy.toFixed(0)}pts → WOULD run ${taskLabel} (dry-run)`);

  log(`${status} → behind ${behindBy.toFixed(0)}pts → run ${taskLabel}`);
  const when = new Date().toISOString();
  try {
    await runTask(cfg, provider, task, state);
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

// Run the loop only when executed directly (`node pacing-agent.mjs`), so the
// pure helpers above can be imported by tests without starting the agent.
const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[pacing] fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

export { parseContinuation, ensureChain, nextDueTask, buildChainPrompt, SANDBOX_SETTINGS, DEFAULT_MAX_TURNS };
