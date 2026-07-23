// Content script: read the REAL usage gauges off gemini.google.com/usage and
// hand ready-made samples to the background worker, which pushes them to
// /api/ingest/usage.
//
// Why an iframe rather than a plain fetch: the usage figures are NOT
// server-rendered. The page ships no AF_initDataCallback data chunks and an
// empty AF_dataServiceRequests, so fetching /usage and parsing the returned HTML
// yields markup with no numbers in it — Angular fills them in client-side after
// load. Rendering the page in a same-origin iframe (framing headers stripped by
// the background worker's declarativeNetRequest rule) is what makes the values
// readable without reverse-engineering Google's batchexecute RPC, whose rpcid is
// undocumented and rotates with each Gemini build.
//
// The selectors and the weekly/current disambiguation follow the approach taken
// by the open-source Zandaland/gemini-usage-bar extension (no LICENSE file, so
// the technique is reimplemented here rather than copied).
//
// If estimates stop flowing, re-check the data-test-id hooks below against the
// live DOM — they are the stable part; class names carry Angular scope
// attributes that change on every Gemini build.

const USAGE_URL = 'https://gemini.google.com/usage';
const IFRAME_ID = 'telemetry-gemini-usage-iframe';
const RENDER_TIMEOUT_MS = 20_000;
const POLL_MS = 500;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// --- Parsing helpers -------------------------------------------------------

/** "42% used" / "42%" -> 42. Returns null when there is no percentage. */
function parsePercent(text) {
  const m = (text || '').match(/(\d+)\s*%\s*used/i) || (text || '').match(/(\d+)\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  // The ingest schema caps utilization at 1000; anything wilder is a misparse.
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : null;
}

function to24h(hour, meridiem) {
  if (!meridiem) return hour; // 24-hour locale
  const isPm = /pm/i.test(meridiem);
  if (hour === 12) return isPm ? 12 : 0;
  return isPm ? hour + 12 : hour;
}

/**
 * Convert the rendered reset label into an absolute ISO timestamp.
 * Handles the two confirmed shapes:
 *   "Resets at 5:45 PM"          -> today at that local time, or tomorrow if past
 *   "Resets Jul 28 at 6:45 PM"   -> that calendar date, rolling to next year if stale
 * Returns null when the label doesn't match; resets_at is nullable server-side,
 * so an unparsed label costs us nothing but the timestamp.
 */
function parseResetTime(text, now = new Date()) {
  if (!text) return null;

  const dated = text.match(
    /resets?\s+(?:on\s+)?([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]\.?M\.?)?/i
  );
  if (dated) {
    const month = MONTHS[dated[1].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    const d = new Date(
      now.getFullYear(), month, Number(dated[2]),
      to24h(Number(dated[3]), dated[5]), Number(dated[4]), 0, 0
    );
    // A reset date well in the past means the label refers to next year.
    if (d.getTime() < now.getTime() - 30 * 86_400_000) d.setFullYear(d.getFullYear() + 1);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const timeOnly = text.match(/resets?\s+at\s+(\d{1,2}):(\d{2})\s*([AP]\.?M\.?)?/i);
  if (timeOnly) {
    const d = new Date(
      now.getFullYear(), now.getMonth(), now.getDate(),
      to24h(Number(timeOnly[1]), timeOnly[3]), Number(timeOnly[2]), 0, 0
    );
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

// --- DOM extraction --------------------------------------------------------

/** Pull {percent, resetText} out of one gauge container. Null when no percentage. */
function extractGauge(el) {
  if (!el) return null;
  const texts = Array.from(el.querySelectorAll('p, div, span'))
    .map((n) => n.textContent.trim())
    .filter(Boolean);
  const own = el.textContent.trim();
  if (texts.length === 0 && own) texts.push(own);

  let percent = null;
  let resetText = '';
  for (const t of texts) {
    if (percent === null) percent = parsePercent(t);
    if (!resetText && /reset/i.test(t)) resetText = t;
  }
  return percent === null ? null : { percent, resetText };
}

function isWeeklyContext(el) {
  let node = el;
  for (let depth = 0; node && depth < 5; depth++) {
    if (/weekly|week|7[-\s]?day/i.test(node.textContent || '')) return true;
    node = node.parentElement;
  }
  return false;
}

function findResetNear(el) {
  let node = el;
  for (let depth = 0; node && depth < 5; depth++) {
    const match = Array.from(node.querySelectorAll?.('p, div, span') ?? [])
      .map((n) => n.textContent.trim())
      .find((t) => /reset/i.test(t));
    if (match) return match;
    node = node.parentElement;
  }
  return '';
}

/**
 * Fallback for when the data-test-id hooks miss (i.e. after a Gemini redesign):
 * scan leaf nodes rendering a percentage and classify each as weekly or current
 * by looking for week-ish wording in its ancestors.
 */
function extractByTextSearch(doc) {
  let current = null;
  let weekly = null;
  for (const el of doc.querySelectorAll('p, div, span, section')) {
    if (el.children.length > 0) continue; // leaves only, or one % counts many times
    const percent = parsePercent(el.textContent.trim());
    if (percent === null) continue;
    const gauge = { percent, resetText: findResetNear(el) };
    if (isWeeklyContext(el)) weekly ??= gauge;
    else current ??= gauge;
  }
  return { current, weekly };
}

function extractUsage(doc) {
  if (!doc || !doc.body) return null;

  let current = extractGauge(doc.querySelector('[data-test-id="gxu-currently"]'));
  let weekly = extractGauge(doc.querySelector('[data-test-id="gxu-weekly"]'));
  if (!current || !weekly) {
    const fallback = extractByTextSearch(doc);
    current ??= fallback.current;
    weekly ??= fallback.weekly;
  }
  if (!current && !weekly) return null;

  // Best-effort extras. Both are class-based and so less stable than the
  // data-test-id hooks; a miss here never invalidates the sample.
  const tier = doc.querySelector('.tier-pill')?.textContent.trim() || null;
  const freshness = doc.querySelector('.usage-metrics-description p')?.textContent.trim() || null;

  return { current, weekly, tier, freshness };
}

/**
 * Shape the scraped gauges into ingest samples.
 * A gauge that failed to parse is OMITTED, never reported as 0 — a fabricated
 * zero renders on the dashboard as a real usage drop, which is worse than a gap
 * because it looks like data.
 */
function buildSamples(usage) {
  const now = new Date();
  const samples = [];
  const push = (window, gauge) => {
    if (!gauge || !Number.isFinite(gauge.percent)) return;
    samples.push({
      window,
      utilization: gauge.percent,
      resets_at: parseResetTime(gauge.resetText, now),
      raw: {
        ...(gauge.resetText ? { reset_text: gauge.resetText } : {}),
        ...(usage.tier ? { tier: usage.tier } : {}),
        ...(usage.freshness ? { source_updated: usage.freshness } : {}),
      },
    });
  };
  push('five_hour', usage.current);
  push('seven_day', usage.weekly);
  return samples;
}

// --- Page rendering --------------------------------------------------------

function ensureIframe() {
  let frame = document.getElementById(IFRAME_ID);
  if (frame) return frame;
  frame = document.createElement('iframe');
  frame.id = IFRAME_ID;
  frame.style.cssText =
    'position:absolute;width:0;height:0;border:none;visibility:hidden;pointer-events:none;';
  document.body.appendChild(frame);
  return frame;
}

/** Poll a document until the gauges render, or we give up. */
function waitForUsage(getDoc, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let doc;
      try {
        doc = getDoc();
      } catch {
        // Cross-origin read => we were redirected to accounts.google.com.
        resolve({ error: 'auth' });
        return;
      }
      if (doc) {
        if (/sign in|sign-in|anmelden|connexion/i.test(doc.title || '')) {
          resolve({ error: 'auth' });
          return;
        }
        const usage = extractUsage(doc);
        if (usage) {
          resolve({ data: { samples: buildSamples(usage), freshness: usage.freshness } });
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve({ error: 'timeout' });
        return;
      }
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

async function scrape() {
  // Already sitting on the usage page: read it directly, no iframe needed.
  if (location.pathname.startsWith('/usage')) {
    return waitForUsage(() => document, RENDER_TIMEOUT_MS);
  }
  const frame = ensureIframe();
  frame.src = `${USAGE_URL}?t=${Date.now()}`;
  return waitForUsage(
    () => frame.contentDocument || frame.contentWindow?.document,
    RENDER_TIMEOUT_MS
  );
}

// Only the top frame answers; the manifest already sets all_frames:false, this
// guards against ever scraping from inside our own hidden iframe.
if (window.self === window.top) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'scrape-usage') return;
    scrape()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // async response
  });
}
