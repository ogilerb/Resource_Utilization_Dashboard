# Telemetry Aggregation Platform — Implementation Plan

## Objective

Build a centralized telemetry system that aggregates (a) hardware metrics from multiple machines and (b) AI/LLM usage and cost data into a single dashboard. The aggregator runs on an Oracle Cloud server using Node.js/Express, PostgreSQL, and an Angular frontend.

## Tech Stack

- **Backend:** Node.js + Express (REST API + WebSocket server)
- **Database:** PostgreSQL
- **Frontend:** Angular (charts via a library of your choice, e.g. ngx-charts or Chart.js)
- **Agents:** Node.js daemon (macOS), PowerShell/WMI service (Windows), local daemon (Oracle server)
- **Schedulers:** `launchd` (macOS), Task Scheduler (Windows), `node-cron` (backend pollers)

## Repository Layout

```
telemetry-platform/
├── server/                 # Express API, WebSocket, cron workers
│   ├── src/
│   │   ├── routes/         # /api/ingest, /api/resources, /api/metrics
│   │   ├── workers/        # gemini-billing.js, anthropic-usage.js
│   │   ├── ws/             # WebSocket broadcast for live compute metrics
│   │   ├── db/             # pg pool, migrations
│   │   └── middleware/     # auth (API key per agent), validation
│   └── migrations/
├── agents/
│   ├── macos/              # Node.js launchd daemon
│   ├── windows/            # PowerShell script + Task Scheduler XML
│   └── oracle/             # local host-metrics daemon
├── dashboard/              # Angular app
└── docker-compose.yml      # postgres + server for local dev
```

## Phase 1 — Backend Core

1. Scaffold Express server with TypeScript, `pg` pool, and environment-based config (`.env`).
2. Create PostgreSQL migrations:

```sql
CREATE TABLE resources (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('compute', 'api')),
  status      TEXT NOT NULL DEFAULT 'active',
  api_key     TEXT UNIQUE,          -- per-agent auth token
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE compute_metrics (
  id           BIGSERIAL PRIMARY KEY,
  resource_id  INT REFERENCES resources(id),
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cpu_percent  REAL,
  memory_bytes BIGINT
);
CREATE INDEX idx_compute_res_time ON compute_metrics (resource_id, timestamp DESC);

CREATE TABLE api_metrics (
  id           BIGSERIAL PRIMARY KEY,
  resource_id  INT REFERENCES resources(id),
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tokens_in    BIGINT,
  tokens_out   BIGINT,
  cost         NUMERIC(12,6)
);
CREATE INDEX idx_api_res_time ON api_metrics (resource_id, timestamp DESC);
```

3. Implement endpoints:
   - `POST /api/ingest/compute` — agents push `{ cpu_percent, memory_bytes }`; authenticated via per-resource API key header; resource resolved from the key.
   - `POST /api/resources` / `GET /api/resources` — register and list monitored entities (dynamic registration, no schema changes needed).
   - `GET /api/metrics/compute?resource_id=&from=&to=` — historical time-series.
   - `GET /api/metrics/api?resource_id=&from=&to=` — token/cost history.
4. WebSocket server: on each compute ingest, broadcast the datapoint to subscribed dashboard clients (channel per resource).
5. Middleware: API-key auth for ingest routes, payload validation (zod or similar), rate limiting.

## Phase 2 — Collection Agents (Push Model)

1. **macOS (MacBook Air):** Node.js daemon polling `sysctl`/`top` every N seconds for CPU and RAM; POSTs JSON over HTTPS. Include a `launchd` plist (`~/Library/LaunchAgents/`) with `KeepAlive` and an install script.
2. **Windows:** PowerShell script using WMI/CIM (`Get-CimInstance Win32_Processor`, `Win32_OperatingSystem`) to gather CPU/RAM; POSTs via `Invoke-RestMethod`. Ship a Task Scheduler definition (or run as a scheduled loop) plus an install script.
3. **Oracle server:** Local Node.js daemon reading `/proc` (or `os` module) for its own host metrics; run under systemd.
4. All agents: configurable interval, endpoint URL, and API key via config file/env; buffer-and-retry on network failure so datapoints aren't lost.

## Phase 3 — API Usage Workers (Pull Model)

1. **Gemini API:** `node-cron` job polling the Google Cloud Billing / usage export daily, aggregating token usage and cost per day, writing to `api_metrics`.
2. **Claude:** Backend worker querying the Anthropic Admin/Usage API for workspace usage and cost, on a schedule. Store tokens in/out and cost.
3. **Gemini Web App (no official usage API):** Implement one of two workarounds behind a common interface:
   - Option A: HTTP proxy on the Oracle server that the browser routes through, counting request/response payload sizes for the Gemini domain.
   - Option B: A browser extension logging prompt/response lengths and POSTing estimates to `/api/ingest/api`.
   Build Option B first (simpler, no TLS interception); design the ingest endpoint so either source works.
4. Idempotency: workers should upsert by (resource, day) so re-runs don't duplicate rows.

## Phase 4 — Angular Dashboard

1. Scaffold Angular app with a service layer for REST + WebSocket.
2. On load, fetch `GET /api/resources` and dynamically render one card/panel per resource — no hardcoded resource list.
3. Generic `ResourceComponent` that switches its visualization by `type`:
   - `compute` → live line chart (CPU %, memory) fed by WebSocket, with a historical range selector backed by REST.
   - `api` → daily bar/area chart of tokens and cost via REST.
4. Add a "Register Resource" form that POSTs to `/api/resources` and returns the generated API key for the new agent.
5. Basic layout: overview grid, per-resource detail view, date-range filters.

## Phase 5 — Deployment & Ops

1. `docker-compose.yml` for local dev (Postgres + server); production deploy on the Oracle server via systemd or Docker.
2. Reverse proxy (nginx/Caddy) with TLS in front of Express; WebSocket upgrade support.
3. Retention job: downsample or purge `compute_metrics` older than a configurable window (e.g. keep raw 7 days, hourly averages 90 days).
4. Health endpoint (`/healthz`) and agent "last seen" tracking so the dashboard can flag offline resources.

## Scalability Requirements

- Adding a new resource must require only: (1) inserting a row via `POST /api/resources`, (2) deploying the collection script with the issued API key. No backend code changes, no schema changes, no frontend changes.
- Ingest routes resolve resources dynamically from the API key — no per-resource route definitions.

## Acceptance Criteria

- [ ] All three machines stream CPU/RAM data visible live on the dashboard.
- [ ] Gemini API and Claude usage/cost appear as daily aggregates.
- [ ] Registering a new resource through the UI produces a working ingest key and an auto-rendered dashboard panel.
- [ ] Agents survive reboots (launchd/Task Scheduler/systemd) and retry on network failure.
- [ ] Historical queries by date range work for both metric types.
- [ ] Metrics tables are indexed on `(resource_id, timestamp)`; retention job runs on schedule.

## Suggested Build Order for Claude Code

1. Phase 1 (backend + DB) with tests for ingest and query endpoints.
2. Oracle server agent (fastest to verify end-to-end locally).
3. Angular dashboard skeleton with live WebSocket chart.
4. macOS and Windows agents.
5. API usage workers (Gemini billing, Anthropic usage), then the Gemini web-app estimator.
6. Deployment hardening and retention.
