import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validateBody } from '../middleware/validate.js';
import { generateApiKey } from '../lib/apiKey.js';
import { config } from '../config.js';

export const resourcesRouter = Router();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['compute', 'api']),
  interval_seconds: z.number().int().positive().max(3600).default(15),
  metadata: z.record(z.unknown()).default({}),
});

// GET /api/resources — list every monitored entity with derived liveness.
// `last_seen` and `online` let the dashboard flag machines that are asleep/off.
resourcesRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         r.id,
         r.name,
         r.type,
         r.status,
         r.interval_seconds,
         r.metadata,
         r.created_at,
         last.last_seen,
         CASE
           WHEN last.last_seen IS NULL THEN false
           WHEN last.last_seen > now() - (r.interval_seconds * $1 || ' seconds')::interval
             THEN true
           ELSE false
         END AS online
       FROM resources r
       LEFT JOIN LATERAL (
         SELECT CASE r.type
                  WHEN 'compute' THEN (SELECT max(timestamp) FROM compute_metrics WHERE resource_id = r.id)
                  WHEN 'api'     THEN (SELECT max(timestamp) FROM api_metrics WHERE resource_id = r.id)
                END AS last_seen
       ) last ON true
       ORDER BY r.created_at ASC`,
      [config.offlineIntervalMultiplier]
    );
    res.json({ resources: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/resources — register a new resource and mint its ingest key.
// The generated api_key is returned ONCE here so it can be dropped into the
// agent config; it is never returned by the list endpoint.
resourcesRouter.post('/', validateBody(createSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSchema>;
    // API-usage resources written only by pull workers don't need an ingest key,
    // but issuing one anyway lets a push source (e.g. Gemini estimator) use it.
    const apiKey = generateApiKey();
    const { rows } = await query(
      `INSERT INTO resources (name, type, api_key, interval_seconds, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, name, type, status, interval_seconds, metadata, created_at`,
      [body.name, body.type, apiKey, body.interval_seconds, JSON.stringify(body.metadata)]
    );
    res.status(201).json({ resource: rows[0], api_key: apiKey });
  } catch (err) {
    next(err);
  }
});
