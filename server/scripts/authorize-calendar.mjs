/**
 * One-time Google Calendar consent flow. Run ONCE, on a machine with a browser:
 *
 *     cd server && node scripts/authorize-calendar.mjs
 *
 * Produces the token file (an "authorized_user" JSON with a long-lived refresh
 * token). Copy that single file to the server — the headless worker only ever
 * refreshes it silently, so the server never runs this script.
 *
 * Requires a "Desktop app" OAuth client saved at GOOGLE_CALENDAR_CREDENTIALS_PATH.
 * An existing Desktop client from another project (e.g. the Garmin/email app)
 * works — just enable the Calendar API on that project; no new client needed.
 *
 * The refresh token stops working only if you revoke it, leave it unused for
 * ~6 months, or leave the OAuth consent screen in "Testing" (Google force-expires
 * those after 7 days). Publish the consent screen ("In production") first.
 */
import 'dotenv/config';
import http from 'node:http';
import { readFile, writeFile, chmod, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { google } from 'googleapis';

// Read-only: this app only ever reads events to aggregate time; it never writes.
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS_PATH || './config/google-credentials.json';
const TOKEN = process.env.GOOGLE_CALENDAR_TOKEN_PATH || './config/google-token.json';

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function tryOpenBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* printing the URL below is enough */
  }
}

async function main() {
  if (!(await exists(CREDENTIALS))) {
    console.error(
      `Missing ${CREDENTIALS}.\n\n` +
        "In the Google Cloud console pick (or reuse) a project, enable the Google\n" +
        "Calendar API, and download an OAuth client of type 'Desktop app' to that path.\n" +
        'An existing Desktop client from another project works too.'
    );
    return 1;
  }
  if (await exists(TOKEN)) {
    console.error(`${TOKEN} already exists. Delete it to re-authorize.`);
    return 1;
  }

  const raw = JSON.parse(await readFile(CREDENTIALS, 'utf8'));
  const cfg = raw.installed || raw.web;
  if (!cfg?.client_id || !cfg?.client_secret) {
    console.error(`${CREDENTIALS} is not a valid OAuth client (expected an "installed"/"web" block).`);
    return 1;
  }
  const { client_id, client_secret } = cfg;

  // Loopback redirect on an ephemeral port — allowed for Desktop clients, same
  // approach as the Garmin app's InstalledAppFlow.run_local_server(port=0).
  const { code, oauth2 } = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname !== '/') {
          res.writeHead(404);
          res.end();
          return;
        }
        const err = u.searchParams.get('error');
        const gotCode = u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorized. You can close this tab and return to the terminal.</h2>');
        server.close();
        if (err) reject(new Error(`OAuth error: ${err}`));
        else if (!gotCode) reject(new Error('No authorization code in redirect'));
        else resolve({ code: gotCode, oauth2: server._oauth2 });
      } catch (e) {
        reject(e);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const oauth2 = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${port}`);
      server._oauth2 = oauth2;
      const authUrl = oauth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // force a refresh_token even on re-consent
        scope: SCOPES,
      });
      console.log(`\nAuthorize this app by visiting:\n\n${authUrl}\n`);
      tryOpenBrowser(authUrl);
    });
  });

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      'No refresh token returned. Revoke this app at https://myaccount.google.com/permissions and retry.'
    );
    return 1;
  }

  // "authorized_user" shape: google.auth.fromJSON() reloads this directly into a
  // self-refreshing client, so the worker needs only this one file at runtime.
  const out = { type: 'authorized_user', client_id, client_secret, refresh_token: tokens.refresh_token };
  await writeFile(TOKEN, JSON.stringify(out, null, 2));
  await chmod(TOKEN, 0o600);
  console.log(`\nWrote ${TOKEN} (chmod 600). Copy it to the server's config dir.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('authorize-calendar failed:', err);
    process.exit(1);
  });
