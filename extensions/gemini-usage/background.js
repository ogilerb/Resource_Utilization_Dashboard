// Background service worker: every ~10 minutes, ask the content script on an
// open gemini.google.com tab to read the usage gauges, then push them to the
// telemetry platform as 'usage'-type samples.
//
// Notes:
// - Unlike the Claude tracker this CANNOT run without a tab: the usage figures
//   are rendered client-side, so a DOM is required to read them. Keep a Gemini
//   tab open in a browser that's usually running.
// - Auth is your ordinary Google session. Because the browser owns the cookie
//   jar, the __Secure-1PSIDTS rotation that breaks server-side collectors is a
//   non-issue here.
// - The backend value is aggregated and lags by up to ~12 minutes ("Updated N
//   min ago"), so polling faster than this gains nothing and only increases
//   abuse-detection exposure.

const ALARM = 'poll-gemini-usage';
const PERIOD_MINUTES = 10;
const FRAME_RULE_ID = 1;

// Re-push even when the gauge values are unchanged if the last push is older
// than this, so the dashboard's "last seen" / online badge stays fresh during
// flat stretches. MUST stay below the server's offline window
// (resource.interval_seconds * OFFLINE_INTERVAL_MULTIPLIER) or the resource
// will still flip to "offline" between heartbeats.
const HEARTBEAT_MS = 15 * 60 * 1000;

// Google refuses to be framed; strip the framing headers on the sub-frame
// request so the content script's hidden iframe can render /usage same-origin.
const rules = [
  {
    id: FRAME_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: { urlFilter: 'gemini.google.com/usage', resourceTypes: ['sub_frame'] },
  },
];

function registerRules() {
  chrome.declarativeNetRequest.updateDynamicRules(
    { removeRuleIds: [FRAME_RULE_ID], addRules: rules },
    () => {
      if (chrome.runtime.lastError) {
        console.error('[gemini-usage] rule registration failed:', chrome.runtime.lastError);
      }
    }
  );
}

/** Self-rescheduling alarm: ±1 min of jitter so polls avoid clock boundaries. */
function schedule() {
  const jitter = (Math.random() - 0.5) * 2;
  chrome.alarms.create(ALARM, { delayInMinutes: PERIOD_MINUTES + jitter });
}

chrome.runtime.onInstalled.addListener(() => {
  registerRules();
  schedule();
});
chrome.runtime.onStartup.addListener(() => {
  registerRules();
  schedule();
});
registerRules(); // in case the worker boots without either event

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  poll()
    .catch((err) => setStatus({ error: err.message }))
    .finally(schedule);
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

async function setStatus(patch) {
  await chrome.storage.local.set({ lastStatusAt: new Date().toISOString(), ...patch });
}

/** Ask each open Gemini tab in turn until one returns gauges. */
async function scrapeFromAnyTab(tabs) {
  let lastError = 'no Gemini tab responded';
  for (const tab of tabs) {
    let reply;
    try {
      reply = await chrome.tabs.sendMessage(tab.id, { type: 'scrape-usage' });
    } catch {
      lastError = 'content script not loaded — reload the Gemini tab';
      continue;
    }
    if (reply?.data) return reply.data;
    if (reply?.error) lastError = reply.error;
  }
  throw new Error(lastError);
}

/**
 * Stable fingerprint of a reading. We dedup on the parsed gauge values — not
 * the scraped freshness label, which can go static (e.g. a redesigned /usage
 * page or a genuinely idle account) and, as the sole gate, silently suppress
 * every push. Sorted so gauge ordering never changes the signature.
 */
function sampleSignature(samples) {
  return samples
    .map((s) => `${s.window}:${s.utilization}:${s.resets_at ?? ''}`)
    .sort()
    .join('|');
}

async function poll() {
  const cfg = await chrome.storage.sync.get(['endpoint', 'apiKey']);
  if (!cfg.endpoint || !cfg.apiKey) {
    console.warn('[gemini-usage] not configured; open the extension options');
    await setStatus({ error: 'not configured' });
    return 0;
  }

  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (tabs.length === 0) {
    // Not an error worth alarming on — just nothing to read right now.
    await setStatus({ error: 'no gemini.google.com tab open' });
    return 0;
  }

  const { samples, freshness } = await scrapeFromAnyTab(tabs);
  if (samples.length === 0) {
    throw new Error('usage page rendered but no gauges parsed — selectors may have changed');
  }

  // Skip only a genuine duplicate: the parsed gauge values are identical to the
  // last push AND that push is still recent. Once it ages past HEARTBEAT_MS we
  // re-push the unchanged reading so "last seen" stays live and the resource
  // doesn't read offline during a flat stretch.
  const signature = sampleSignature(samples);
  const { lastSignature, lastPush } = await chrome.storage.local.get(['lastSignature', 'lastPush']);
  const ageMs = lastPush ? Date.now() - Date.parse(lastPush) : Infinity;
  if (signature === lastSignature && ageMs < HEARTBEAT_MS) {
    await setStatus({ error: null, lastSkipped: 'unchanged since last poll' });
    return 0;
  }

  const res = await fetch(cfg.endpoint.replace(/\/$/, '') + '/api/ingest/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey },
    body: JSON.stringify({ samples }),
  });
  if (!res.ok) throw new Error(`telemetry ingest ${res.status}`);

  await setStatus({
    lastSignature: signature,
    lastFreshness: freshness ?? null,
    lastPush: new Date().toISOString(),
    lastCount: samples.length,
    lastSkipped: null,
    error: null,
  });
  console.log(`[gemini-usage] pushed ${samples.length} gauge(s)`);
  return samples.length;
}
