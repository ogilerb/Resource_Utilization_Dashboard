# Telemetry Aggregation Platform

A centralized telemetry system that aggregates **hardware metrics** (CPU/RAM from
multiple machines) and **AI/LLM usage & cost** (Gemini, Claude) into a single
live dashboard. Designed to run the aggregator on an Oracle Cloud server.

See [PLAN.md](PLAN.md) for the full design. This README covers what's built and
how to run it.

## Architecture

```
  macOS agent ─┐                            ┌── Angular dashboard (REST + WebSocket)
  Windows agent ┼─ push CPU/RAM ─▶  server  ┤
  Oracle agent ─┘   (/api/ingest)  (Express │   ├─ /api/resources  (dynamic registration)
                                    +  WS +  │   ├─ /api/metrics/*  (history)
  Anthropic API ─┐                  workers) │   └─ /ws             (live compute)
  Gemini billing ┼─ pull (cron) ──▶         │
  Gemini web app ┘  push (extension)  Postgres (resources, compute_metrics, api_metrics)
```

- **Push model** for compute: agents POST datapoints; the resource is resolved
  from the per-agent API key, so adding a machine needs **no code/schema/route
  changes** — just register it and deploy the agent with its key.
- **Pull model** for API usage: cron workers query the Anthropic Admin API and
  the Google Cloud billing export; the Gemini *web app* (no official API) is
  estimated by a browser extension that pushes token estimates.

### Offline / sleeping machines

A closed or sleeping laptop produces no data (correct — there's no utilization to
report, and the OS keeps no history for the sleep window). The platform treats
absence as a first-class state:

- Each resource has an `interval_seconds`; the server derives `last_seen` and an
  `online` flag (offline when the last datapoint is older than
  `interval_seconds × OFFLINE_INTERVAL_MULTIPLIER`).
- The dashboard shows an **offline badge** and renders **gaps in the line**
  (Chart.js `spanGaps: false` + null insertion) rather than drawing zeros across
  the sleep window.
- Agents **buffer-and-retry** on network loss so awake-but-offline periods aren't
  lost; sleep periods legitimately show as gaps.

## Repository layout

| Path | What |
|------|------|
| `server/` | Express + TypeScript API, WebSocket, cron workers, Postgres migrations |
| `agents/macos/` | Node.js launchd agent (this laptop) |
| `agents/windows/` | PowerShell/CIM agent + Task Scheduler definition |
| `agents/oracle/` | Node.js systemd agent (runs on the aggregator host) |
| `agents/shared/` | Shared collector + buffer-and-retry core |
| `extensions/gemini-estimator/` | MV3 browser extension estimating Gemini web-app usage |
| `dashboard/` | Angular 18 app (Chart.js) |
| `deploy/` | nginx TLS/WebSocket config, systemd unit for the server |
| `docker-compose.yml` | Postgres + server for local dev / single-host prod |

## Quick start (local dev)

```bash
# 1. Postgres + server (auto-migrates on boot)
docker compose up --build          # server on :4000, postgres on :5432

# 2. Dashboard
cd dashboard && npm install && npm start   # http://localhost:4200
```

Then open the dashboard, **Register Resource**, copy the API key, and point an
agent at it.

### Run the server without Docker

```bash
cd server
cp .env.example .env                # edit DATABASE_URL etc.
npm install
npm run migrate                     # or rely on auto-migrate at startup
npm run dev                         # tsx watch; or: npm run build && npm start
npm test                            # endpoint tests (need a reachable Postgres)
```

## Registering a resource

`POST /api/resources` (also via the dashboard form) returns a one-time API key:

```bash
curl -s localhost:4000/api/resources \
  -H 'content-type: application/json' \
  -d '{"name":"MacBook Air","type":"compute","interval_seconds":15}'
# → { "resource": { "id": 1, ... }, "api_key": "tk_..." }
```

## Deploying agents

- **macOS:** copy `agents/` to the machine, `cp agents/macos/config.example.json
  agents/macos/config.json`, fill in `endpoint` + `apiKey`, then
  `./agents/macos/install.sh` (launchd, restarts on wake).
- **Windows:** copy `agents/windows/`, fill in `config.json`, run
  `install.ps1` elevated (Task Scheduler at boot/logon).
- **Oracle server:** `sudo ./agents/oracle/install.sh` (systemd).

All agents take `endpoint`, `apiKey`, `intervalSeconds`, `bufferFile` via config
file or `TELEMETRY_*` env vars.

## API usage collection

- **Claude:** set `ANTHROPIC_ADMIN_KEY` in the server env — the hourly worker
  pulls token usage + cost from the Anthropic Admin API into a `Claude API`
  resource (auto-created).
- **Gemini API:** set `GEMINI_BILLING_TABLE` (+ `GOOGLE_APPLICATION_CREDENTIALS`)
  to pull cost from the BigQuery billing export. Requires the optional
  `@google-cloud/bigquery` package (`npm i @google-cloud/bigquery` in `server/`).
- **Gemini web app:** load `extensions/gemini-estimator/` as an unpacked
  extension (chrome://extensions → Developer mode → Load unpacked), open its
  options, and paste the endpoint + an `api`-type resource key. It pushes daily
  token estimates to `/api/ingest/api` (`increment=true`).

## Production deploy (Oracle)

The whole stack (Postgres + server + dashboard/nginx) comes up with one command
— the dashboard is published on port 80, everything else stays internal:

```bash
docker compose up -d --build
```

See **[deploy/ORACLE_DEPLOY.md](deploy/ORACLE_DEPLOY.md)** for the full Ubuntu/OCI
runbook: installing Docker, the OCI + host firewall, always-on-across-reboots,
and access via Tailscale (recommended) or a public IP with optional HTTPS.

Retention/downsampling runs automatically (`RETENTION_*` env); raw compute
metrics are rolled up to hourly averages and purged per the configured windows.
`deploy/nginx.conf` + `deploy/telemetry-server.service` remain for a non-Docker
host-nginx deploy if you prefer that over containers.

## Acceptance criteria status

| Criterion | Status |
|-----------|--------|
| Machines stream CPU/RAM live to the dashboard | ✅ agents + `/api/ingest/compute` + WS |
| Gemini & Claude usage/cost as daily aggregates | ✅ pull workers + estimator |
| Register via UI → working key + auto-rendered panel | ✅ `/register` + dynamic overview |
| Agents survive reboots + retry on failure | ✅ launchd/Task Scheduler/systemd + buffer |
| Historical queries by date range (both types) | ✅ `/api/metrics/*?from=&to=` |
| Indexed `(resource_id, timestamp)`; retention on schedule | ✅ migration indexes + cron |
```
