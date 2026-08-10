/**
 * One-time: copy each configured calendar's Google colour into calendars.json so
 * the dashboard's time panel matches Google Calendar.
 *
 *     cd server && node scripts/sync-calendar-colors.mjs          # fill blanks
 *     cd server && node scripts/sync-calendar-colors.mjs --force  # overwrite all
 *
 * Reads the same token minted by scripts/authorize-calendar.mjs (calendar.readonly
 * — no extra scope needed) and the calendars file at GOOGLE_CALENDARS_FILE. For
 * every entry whose `id` is present in your Google calendar list it writes that
 * calendar's `backgroundColor` (the hex Google displays) into a `color` field,
 * preserving the file's structure and comment. Existing colours are kept unless
 * --force is passed. You only need to run this once; the worker never does.
 */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { google } from 'googleapis';

const TOKEN = process.env.GOOGLE_CALENDAR_TOKEN_PATH || './config/google-token.json';
const CALENDARS = process.env.GOOGLE_CALENDARS_FILE || './config/calendars.json';
const FORCE = process.argv.includes('--force');

async function main() {
  let token;
  try {
    token = JSON.parse(await readFile(TOKEN, 'utf8'));
  } catch (err) {
    console.error(`Cannot read token ${TOKEN}: ${err.message}`);
    console.error('Run scripts/authorize-calendar.mjs first (or set GOOGLE_CALENDAR_TOKEN_PATH).');
    return 1;
  }

  let doc;
  try {
    doc = JSON.parse(await readFile(CALENDARS, 'utf8'));
  } catch (err) {
    console.error(`Cannot read calendars file ${CALENDARS}: ${err.message}`);
    return 1;
  }
  const entries = Array.isArray(doc.calendars) ? doc.calendars : [];
  if (entries.length === 0) {
    console.error(`${CALENDARS} has no calendars[] entries.`);
    return 1;
  }

  // Self-refreshing client from the stored refresh token — same as the worker.
  const auth = google.auth.fromJSON(token);
  const cal = google.calendar({ version: 'v3', auth });

  // Build id → backgroundColor over the (possibly paginated) calendar list.
  const colorById = new Map();
  let pageToken;
  do {
    const resp = await cal.calendarList.list({ maxResults: 250, pageToken });
    for (const item of resp.data.items ?? []) {
      if (item.id && item.backgroundColor) colorById.set(item.id, item.backgroundColor);
    }
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);

  let updated = 0;
  const missing = [];
  for (const c of entries) {
    if (!c?.id || c.id.startsWith('FILL_ME')) continue;
    const color = colorById.get(c.id);
    if (!color) {
      missing.push(c.category || c.id);
      continue;
    }
    if (c.color && !FORCE) continue; // keep an existing colour unless --force
    if (c.color === color) continue; // already in sync
    c.color = color;
    updated++;
    console.log(`  ${c.category || c.id} → ${color}`);
  }

  if (missing.length) {
    console.warn(
      `\nNot in your Google calendar list (left unchanged): ${missing.join(', ')}.\n` +
        'Make sure those calendars are added to the authorized account.'
    );
  }

  if (updated === 0) {
    console.log('\nNo changes — every configured calendar already has a colour.');
    return 0;
  }

  // Preserve 2-space formatting and the trailing newline.
  await writeFile(CALENDARS, JSON.stringify(doc, null, 2) + '\n');
  console.log(`\nWrote ${updated} colour(s) to ${CALENDARS}.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('sync-calendar-colors failed:', err);
    process.exit(1);
  });
