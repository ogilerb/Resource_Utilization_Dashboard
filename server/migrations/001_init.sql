-- Telemetry platform — initial schema.
-- Resources are registered dynamically; adding one never requires code/schema changes.

CREATE TABLE IF NOT EXISTS resources (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('compute', 'api')),
  status           TEXT NOT NULL DEFAULT 'active',
  api_key          TEXT UNIQUE,             -- per-agent auth token (compute agents)
  -- Expected reporting cadence; used to compute offline state per-resource.
  interval_seconds INT NOT NULL DEFAULT 15,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compute_metrics (
  id           BIGSERIAL PRIMARY KEY,
  resource_id  INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cpu_percent  REAL,
  memory_bytes BIGINT
);
CREATE INDEX IF NOT EXISTS idx_compute_res_time ON compute_metrics (resource_id, timestamp DESC);

-- Hourly downsample of compute_metrics (populated by the retention worker).
CREATE TABLE IF NOT EXISTS compute_metrics_hourly (
  resource_id      INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  bucket           TIMESTAMPTZ NOT NULL,       -- date_trunc('hour', timestamp)
  cpu_percent_avg  REAL,
  cpu_percent_max  REAL,
  memory_bytes_avg BIGINT,
  memory_bytes_max BIGINT,
  sample_count     INT NOT NULL,
  PRIMARY KEY (resource_id, bucket)
);
CREATE INDEX IF NOT EXISTS idx_compute_hourly_res_time ON compute_metrics_hourly (resource_id, bucket DESC);

CREATE TABLE IF NOT EXISTS api_metrics (
  id           BIGSERIAL PRIMARY KEY,
  resource_id  INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  -- Truncated to the aggregation day so workers can upsert idempotently.
  day          DATE NOT NULL,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tokens_in    BIGINT NOT NULL DEFAULT 0,
  tokens_out   BIGINT NOT NULL DEFAULT 0,
  cost         NUMERIC(12,6) NOT NULL DEFAULT 0,
  UNIQUE (resource_id, day)
);
CREATE INDEX IF NOT EXISTS idx_api_res_time ON api_metrics (resource_id, day DESC);
