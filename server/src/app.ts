import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { ingestRouter } from './routes/ingest.js';
import { resourcesRouter } from './routes/resources.js';
import { metricsRouter } from './routes/metrics.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { requireDashboardAuth } from './middleware/dashboardAuth.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // behind nginx/Caddy; needed for correct req.ip
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
    })
  );
  app.use(express.json({ limit: '256kb' }));

  // Health stays open for load-balancer/uptime checks (no data exposed).
  app.use(healthRouter);
  // Ingest authenticates with per-agent API keys (see requireApiKey), not the
  // dashboard token.
  app.use('/api/ingest', ingestRouter);
  // Everything below reads or mutates dashboard data: gate behind the dashboard
  // token. Fails closed when DASHBOARD_TOKEN is unset.
  app.use('/api/resources', requireDashboardAuth, resourcesRouter);
  app.use('/api/metrics', requireDashboardAuth, metricsRouter);
  app.use('/api/analytics', requireDashboardAuth, analyticsRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // Centralized error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
