import 'dotenv/config';

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export const config = {
  port: num('PORT', 4000),
  corsOrigin: str('CORS_ORIGIN', '*'),

  // Single shared secret gating all read/admin endpoints and the WebSocket.
  // When empty the API fails CLOSED (refuses to serve those routes) so a deploy
  // is never accidentally left open. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  dashboardToken: process.env.DASHBOARD_TOKEN || '',

  db: {
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: bool('PGSSL', false) ? { rejectUnauthorized: false } : undefined,
  },

  ingestRate: {
    windowMs: num('INGEST_RATE_WINDOW_MS', 60_000),
    max: num('INGEST_RATE_MAX', 600),
  },

  offlineIntervalMultiplier: num('OFFLINE_INTERVAL_MULTIPLIER', 3),

  retention: {
    rawDays: num('RETENTION_RAW_DAYS', 7),
    hourlyDays: num('RETENTION_HOURLY_DAYS', 90),
    cron: str('RETENTION_CRON', '0 3 * * *'),
  },

  anthropic: {
    adminKey: process.env.ANTHROPIC_ADMIN_KEY || '',
    resourceName: str('ANTHROPIC_RESOURCE_NAME', 'Claude API'),
    cron: str('ANTHROPIC_USAGE_CRON', '0 * * * *'),
  },

  gemini: {
    billingTable: process.env.GEMINI_BILLING_TABLE || '',
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    resourceName: str('GEMINI_RESOURCE_NAME', 'Gemini API'),
    cron: str('GEMINI_BILLING_CRON', '0 4 * * *'),
  },

  // Google Calendar time analytics. The worker is disabled unless BOTH a token
  // file (minted once via scripts/authorize-calendar.mjs) and a calendars file
  // (id→category→tier map) are configured. Read-only OAuth; own token, separate
  // from GOOGLE_APPLICATION_CREDENTIALS (which is the Gemini BigQuery service
  // account — a different Google auth mode).
  calendar: {
    tokenPath: process.env.GOOGLE_CALENDAR_TOKEN_PATH || '',
    credentialsPath: process.env.GOOGLE_CALENDAR_CREDENTIALS_PATH || '',
    calendarsFile: process.env.GOOGLE_CALENDARS_FILE || '',
    resourceName: str('CALENDAR_RESOURCE_NAME', 'Time Tracking'),
    cron: str('CALENDAR_CRON', '0 * * * *'),
    // Day boundaries are computed in this timezone so per-day buckets are local.
    timezone: str('CALENDAR_TIMEZONE', 'America/Vancouver'),
    // Each scheduled run recomputes the last N days (catches edits/deletes).
    recomputeDays: num('CALENDAR_RECOMPUTE_DAYS', 14),
    // The one-time backfill script pulls this many days of history.
    backfillDays: num('CALENDAR_BACKFILL_DAYS', 365),
  },
} as const;

export type Config = typeof config;
