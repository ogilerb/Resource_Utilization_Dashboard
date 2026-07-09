import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { attachWebSocket } from '../src/ws/broadcast.js';

export interface TestCtx {
  server: Server;
  baseUrl: string;
}

/**
 * Returns true if a test Postgres is reachable. Tests skip (rather than fail)
 * when DB is unavailable, so `npm test` is meaningful even on a laptop with no
 * local Postgres — CI/docker-compose provides one.
 */
export async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Migrate + truncate to a clean slate. */
export async function resetDb(): Promise<void> {
  await migrate();
  await pool.query('TRUNCATE resources RESTART IDENTITY CASCADE');
}

export async function startTestServer(): Promise<TestCtx> {
  const app = createApp();
  const server = createServer(app);
  attachWebSocket(server, '/ws');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

export async function stopTestServer(ctx: TestCtx): Promise<void> {
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
}
