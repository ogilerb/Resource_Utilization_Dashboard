import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { loadCalendars } from '../lib/calendars.js';
import { ensureCalendarResource, replaceTimeMetrics, type TimeBucket } from './upsertResource.js';

/**
 * Pull events from the life-domain Google Calendars and aggregate minutes-per-
 * category-per-local-day into time_metrics. The reverse of the Garmin watch app,
 * which *writes* one active domain at a time to these calendars; here we *read*
 * them back into time analytics.
 *
 * Setup (one-time): see scripts/authorize-calendar.mjs + config/calendars.json.
 *
 * googleapis is imported dynamically so a missing install degrades gracefully
 * (the worker no-ops) rather than crashing the server — same posture as the
 * Gemini BigQuery worker.
 *
 * Read-only: the OAuth token is calendar.readonly and this only ever lists events.
 */
export async function runCalendarTime(days = config.calendar.recomputeDays): Promise<void> {
  if (!config.calendar.tokenPath) {
    console.log('[calendar-time] GOOGLE_CALENDAR_TOKEN_PATH not set; skipping');
    return;
  }
  const calendars = loadCalendars();
  if (calendars.length === 0) {
    console.log('[calendar-time] no calendars configured (calendars.json); skipping');
    return;
  }

  let google: any;
  try {
    const mod = 'googleapis';
    ({ google } = await import(/* @vite-ignore */ mod));
  } catch {
    console.log('[calendar-time] googleapis not installed; skipping');
    return;
  }

  // Auth: reload the "authorized_user" token into a self-refreshing client. No
  // browser and no disk write needed — refresh tokens are stable for a published
  // consent screen, so we don't persist rotated access tokens (keeps a read-only
  // secrets mount working).
  let auth: any;
  try {
    const token = JSON.parse(await readFile(config.calendar.tokenPath, 'utf8'));
    auth = google.auth.fromJSON(token);
  } catch (err) {
    console.error(`[calendar-time] cannot load token ${config.calendar.tokenPath}:`, err);
    return;
  }
  const cal = google.calendar({ version: 'v3', auth });

  const tz = config.calendar.timezone;
  const nowMs = Date.now();
  // Start the window at LOCAL midnight so day buckets are complete and the
  // delete-then-insert range lines up exactly with the days we aggregate.
  const windowStartDay = localDayString(new Date(nowMs - days * 86_400_000), tz);
  const timeMinMs = localMidnightInstant(windowStartDay, tz);
  const timeMin = new Date(timeMinMs).toISOString();
  const timeMax = new Date(nowMs).toISOString();

  const resourceId = await ensureCalendarResource(config.calendar.resourceName);

  // key = `${day}|${category}` → bucket
  const buckets = new Map<string, TimeBucket>();
  const bucketFor = (day: string, category: string): TimeBucket => {
    const key = `${day}|${category}`;
    let b = buckets.get(key);
    if (!b) {
      b = { day, category, minutes: 0, event_count: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  let totalEvents = 0;
  for (const c of calendars) {
    let pageToken: string | undefined;
    do {
      const resp = await cal.events.list({
        calendarId: c.id,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500,
        pageToken,
      });
      const items: any[] = resp.data.items ?? [];
      for (const ev of items) {
        // Only timed events (Garmin writes these); skip all-day and cancelled.
        if (ev.status === 'cancelled') continue;
        const startIso = ev.start?.dateTime;
        const endIso = ev.end?.dateTime;
        if (!startIso || !endIso) continue;

        // Clamp to the window so every segment lands on a day we delete+reinsert
        // (prevents duplicate rows for days before windowStartDay), and never
        // count minutes past "now" for an in-progress event.
        const startMs = Math.max(Date.parse(startIso), timeMinMs);
        const endMs = Math.min(Date.parse(endIso), nowMs);
        if (!(endMs > startMs)) continue;

        totalEvents++;
        const segments = splitByLocalDay(startMs, endMs, tz);
        segments.forEach((seg, i) => {
          const b = bucketFor(seg.day, c.category);
          b.minutes += seg.minutes;
          if (i === 0) b.event_count += 1; // count the block on its start day
        });
      }
      pageToken = resp.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  await replaceTimeMetrics(resourceId, windowStartDay, [...buckets.values()]);
  console.log(
    `[calendar-time] ${totalEvents} event(s) → ${buckets.size} (day,category) bucket(s) ` +
      `since ${windowStartDay} for "${config.calendar.resourceName}"`
  );
}

// --- timezone helpers -------------------------------------------------------
// Node has no zoned-date arithmetic; we derive local days/midnights via Intl.
// The DST-transition edge (a doubled/skipped hour) is not worth special-casing
// for time-tracking totals.

/** 'YYYY-MM-DD' local calendar date of an instant in the given IANA timezone. */
function localDayString(date: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Offset (tz − UTC) in ms at the given instant. */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = Number(p.value);
  const hour = m.hour === 24 ? 0 : m.hour; // some engines emit '24' at midnight
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, hour, m.minute, m.second);
  return asUTC - date.getTime();
}

/** UTC instant (ms) of local 00:00 in `tz` for the given 'YYYY-MM-DD'. */
function localMidnightInstant(dayStr: string, tz: string): number {
  const naiveUTC = Date.parse(`${dayStr}T00:00:00Z`); // treat wall-clock as UTC
  const offset = tzOffsetMs(new Date(naiveUTC), tz);
  return naiveUTC - offset;
}

/** Next calendar date string after 'YYYY-MM-DD'. */
function nextDay(dayStr: string): string {
  return new Date(Date.parse(`${dayStr}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Split [startMs,endMs) into per-local-day segments with minute durations. */
function splitByLocalDay(
  startMs: number,
  endMs: number,
  tz: string
): { day: string; minutes: number }[] {
  const out: { day: string; minutes: number }[] = [];
  let cur = startMs;
  // Guard against pathological loops; a single event won't span many days.
  let guard = 0;
  while (cur < endMs && guard++ < 400) {
    const day = localDayString(new Date(cur), tz);
    const boundary = localMidnightInstant(nextDay(day), tz);
    const segEnd = Math.min(endMs, boundary);
    out.push({ day, minutes: (segEnd - cur) / 60_000 });
    cur = segEnd;
  }
  return out;
}
