import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { ingestRouter } from './routes/ingest.js';
import { resourcesRouter } from './routes/resources.js';
import { metricsRouter } from './routes/metrics.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { requireDashboardAuth } from './middleware/dashboardAuth.js';
import { authLimiter } from './middleware/rateLimit.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // behind nginx/Caddy; needed for correct req.ip

  // Security headers. The API serves JSON only, so lock the CSP all the way down
  // — nothing should ever load a subresource from an API response — and send
  // HSTS since the platform must run over TLS once it holds financial data.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
    })
  );

  // CORS. Empty origin = no CORS headers (same-origin production deployment
  // behind nginx). Only an explicit `*` opens it to any origin.
  const corsOrigin = config.corsOrigin.trim();
  if (corsOrigin) {
    app.use(
      cors({
        origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()),
      })
    );
  }

  app.use(express.json({ limit: '256kb' }));

  // Health stays open for load-balancer/uptime checks (no data exposed).
  app.use(healthRouter);
  // Ingest authenticates with per-agent API keys (see requireApiKey), not the
  // dashboard token.
  app.use('/api/ingest', ingestRouter);
  // Everything below reads or mutates dashboard data: gate behind the dashboard
  // token (fails closed when DASHBOARD_TOKEN is unset). authLimiter throttles
  // repeated failed attempts per IP so the shared token can't be ground down.
  const gated = ['/api/resources', '/api/metrics', '/api/analytics'];
  app.use(gated, authLimiter);
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
