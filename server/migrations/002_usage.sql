-- Subscription usage gauges (e.g. Claude Pro): percent-of-limit samples over
-- time, per window ('five_hour', 'seven_day', 'extra_spend', ...). Generic —
-- new windows/models need no schema change.

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_type_check;
ALTER TABLE resources ADD CONSTRAINT resources_type_check
  CHECK (type IN ('compute', 'api', 'usage'));

CREATE TABLE IF NOT EXISTS usage_metrics (
  id           BIGSERIAL PRIMARY KEY,
  resource_id  INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_kind  TEXT NOT NULL,        -- 'five_hour' | 'seven_day' | 'extra_spend' | 'weekly_<model>'
  utilization  REAL NOT NULL,        -- percent of the window's limit used
  resets_at    TIMESTAMPTZ,          -- when this window resets, if known
  raw          JSONB                 -- optional extras (spend amounts, etc.)
);
CREATE INDEX IF NOT EXISTS idx_usage_res_time ON usage_metrics (resource_id, timestamp DESC);
