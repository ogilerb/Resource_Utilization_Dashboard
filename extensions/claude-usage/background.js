// Background service worker: every 15 minutes, read the account-wide usage
// gauges from claude.ai's internal usage endpoint (the same data shown on
// Settings → Usage) and push them to the telemetry platform.
//
// Notes:
// - This is an UNOFFICIAL endpoint; if Anthropic changes it, update the paths
//   in claudeFetch()/poll() below.
// - Uses your existing claude.ai browser session (cookies). Account-wide, so
//   it captures web + Claude Code usage across all your machines — install in
//   one browser that's usually open.
// - chrome.alarms fires even with no claude.ai tab open, as long as the
//   browser is running.

const ALARM = 'poll-claude-usage';
const PERIOD_MINUTES = 15;

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);

function schedule() {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 0.2 });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll();
});

// "Poll now" button in the options page.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'poll-now') {
    poll()
      .then((n) => sendResponse({ ok: true, samples: n }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }
});

async function claudeFetch(path) {
  const res = await fetch('https://claude.ai' + path, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`claude.ai ${res.status} for ${path}`);
  return res.json();
}

async function getOrgId() {
  const { orgId } = await chrome.storage.local.get('orgId');
  if (orgId) return orgId;
  const orgs = await claudeFetch('/api/organizations');
  const org = Array.isArray(orgs)
    ? orgs.find((o) => (o.capabilities || []).includes('chat')) ?? orgs[0]
    : null;
  if (!org?.uuid) throw new Error('No organization found — are you logged in to claude.ai?');
  await chrome.storage.local.set({ orgId: org.uuid });
  return org.uuid;
}

function buildSamples(usage) {
  const samples = [];
  const push = (window, utilization, resets_at, raw) => {
    if (typeof utilization === 'number' && Number.isFinite(utilization)) {
      samples.push({ window, utilization, resets_at: resets_at ?? null, ...(raw ? { raw } : {}) });
    }
  };

  push('five_hour', usage.five_hour?.utilization, usage.five_hour?.resets_at);
  push('seven_day', usage.seven_day?.utilization, usage.seven_day?.resets_at);

  // Per-model / scoped weekly limits, when present.
  for (const lim of usage.limits ?? []) {
    if (lim.kind === 'weekly_scoped' && lim.scope?.model?.display_name) {
      const name = lim.scope.model.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      push(`weekly_${name}`, lim.percent, lim.resets_at);
    }
  }

  // Extra-usage (pay-per-use overage credits) as its own gauge.
  if (usage.spend?.enabled) {
    push('extra_spend', usage.spend.percent, null, {
      used: usage.spend.used,
      limit: usage.spend.limit,
    });
  } else if (usage.extra_usage?.is_enabled) {
    push('extra_spend', usage.extra_usage.utilization, null, {
      used_credits: usage.extra_usage.used_credits,
      monthly_limit: usage.extra_usage.monthly_limit,
      currency: usage.extra_usage.currency,
    });
  }
  return samples;
}

async function poll() {
  const cfg = await chrome.storage.sync.get(['endpoint', 'apiKey']);
  if (!cfg.endpoint || !cfg.apiKey) {
    console.warn('[claude-usage] not configured; open the extension options');
    return 0;
  }

  const orgId = await getOrgId();
  let usage;
  try {
    usage = await claudeFetch(`/api/organizations/${orgId}/usage`);
  } catch (err) {
    // Org id may be stale (e.g. re-login) — clear the cache so next run rediscovers.
    await chrome.storage.local.remove('orgId');
    throw err;
  }

  const samples = buildSamples(usage);
  if (samples.length === 0) {
    console.warn('[claude-usage] endpoint responded but no gauges found — schema change?');
    return 0;
  }

  const res = await fetch(cfg.endpoint.replace(/\/$/, '') + '/api/ingest/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey },
    body: JSON.stringify({ samples }),
  });
  if (!res.ok) throw new Error(`telemetry ingest ${res.status}`);
  await chrome.storage.local.set({ lastPush: new Date().toISOString(), lastCount: samples.length });
  console.log(`[claude-usage] pushed ${samples.length} gauge(s)`);
  return samples.length;
}
