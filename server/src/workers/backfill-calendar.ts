import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { runCalendarTime } from './calendar-time.js';

/**
 * One-time historical backfill of calendar time_metrics.
 *
 *   npm run backfill:calendar            # last CALENDAR_BACKFILL_DAYS days
 *   npm run backfill:calendar -- 730     # override the window (days)
 *
 * In Docker: `docker compose exec server node dist/workers/backfill-calendar.js [days]`.
 * Regular scheduled runs only recompute the last CALENDAR_RECOMPUTE_DAYS; this
 * loads the deep history once. Safe to re-run (delete-then-insert per day).
 */
const days = Number(process.argv[2]) || config.calendar.backfillDays;

console.log(`[backfill-calendar] backfilling last ${days} day(s)…`);
runCalendarTime(days)
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-calendar] failed', err);
    process.exit(1);
  });
