-- Time-tracking analytics from Google Calendar. A genuinely new metric shape
-- (per-day minutes bucketed by category), so it gets its own table rather than
-- overloading api_metrics/usage_metrics — following the 002 precedent of
-- widening the resources.type CHECK and adding a purpose-built table.
--
-- One calendar = one category (the life-domain the Garmin app writes into), so
-- `category` is the domain name. minutes/event_count are aggregated per local
-- day by the calendar-time worker. event_count summed across a day's categories
-- is that day's domain-switch count (one contiguous block = one event), which
-- drives the fragmentation metric with no extra table.

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_type_check;
ALTER TABLE resources ADD CONSTRAINT resources_type_check
  CHECK (type IN ('compute', 'api', 'usage', 'calendar'));

CREATE TABLE IF NOT EXISTS time_metrics (
  id           BIGSERIAL PRIMARY KEY,
  resource_id  INT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  day          DATE NOT NULL,           -- local calendar day (worker's configured timezone)
  category     TEXT NOT NULL,           -- domain name; 1 calendar = 1 category
  minutes      INT  NOT NULL,           -- minutes spent in this category on this day
  event_count  INT  NOT NULL DEFAULT 0, -- contiguous blocks (events) that day → fragmentation
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(), -- last write; drives resource liveness
  UNIQUE (resource_id, day, category)
);
CREATE INDEX IF NOT EXISTS idx_time_res_day ON time_metrics (resource_id, day);
