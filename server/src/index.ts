import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { attachWebSocket, closeWebSocket } from './ws/broadcast.js';
import { startWorkers } from './workers/index.js';

async function main() {
  // Apply pending migrations on boot so a fresh deploy is self-provisioning.
  await migrate();

  const app = createApp();
  const server = createServer(app);
  attachWebSocket(server, '/ws');
  startWorkers();

  server.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (ws at /ws)`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    closeWebSocket();
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] fatal startup error', err);
  process.exit(1);
});
