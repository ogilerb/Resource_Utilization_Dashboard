import { Router } from 'express';
import { query } from '../db/pool.js';

export const healthRouter = Router();

// GET /healthz — liveness + DB reachability for load balancers / uptime checks.
healthRouter.get('/healthz', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'up', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down', time: new Date().toISOString() });
  }
});
