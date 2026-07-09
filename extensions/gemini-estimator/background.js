// Background service worker: batch usage increments and push them to the
// telemetry ingest endpoint. Uses increment=true so multiple pushes across the
// day accumulate into a single (resource, day) row on the server.

let batch = { tokens_in: 0, tokens_out: 0 };
let flushTimer = null;
const FLUSH_MS = 15_000;

async function getConfig() {
  const { endpoint, apiKey, costPer1kIn, costPer1kOut } = await chrome.storage.sync.get([
    'endpoint',
    'apiKey',
    'costPer1kIn',
    'costPer1kOut',
  ]);
  return { endpoint, apiKey, costPer1kIn: Number(costPer1kIn) || 0, costPer1kOut: Number(costPer1kOut) || 0 };
}

async function flush() {
  flushTimer = null;
  const { tokens_in, tokens_out } = batch;
  if (tokens_in === 0 && tokens_out === 0) return;

  const cfg = await getConfig();
  if (!cfg.endpoint || !cfg.apiKey) {
    console.warn('[gemini-estimator] not configured; open the extension options');
    return;
  }
  batch = { tokens_in: 0, tokens_out: 0 };

  const cost =
    (tokens_in / 1000) * cfg.costPer1kIn + (tokens_out / 1000) * cfg.costPer1kOut;
  const day = new Date().toISOString().slice(0, 10);

  try {
    const res = await fetch(cfg.endpoint.replace(/\/$/, '') + '/api/ingest/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey },
      body: JSON.stringify({ day, tokens_in, tokens_out, cost, increment: true }),
    });
    if (!res.ok) throw new Error(`ingest ${res.status}`);
    console.log(`[gemini-estimator] reported +${tokens_in}/${tokens_out} tokens`);
  } catch (err) {
    // Re-queue on failure so nothing is lost.
    batch.tokens_in += tokens_in;
    batch.tokens_out += tokens_out;
    console.warn('[gemini-estimator] push failed, will retry', err.message);
    scheduleFlush();
  }
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'gemini-usage') return;
  batch.tokens_in += msg.tokens_in || 0;
  batch.tokens_out += msg.tokens_out || 0;
  scheduleFlush();
});
