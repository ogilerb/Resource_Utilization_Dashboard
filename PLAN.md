# Telemetry Aggregation Platform — Roadmap

## Current state

The core platform is **built and running**. The aggregator runs on the Oracle Cloud server (Node/Express + PostgreSQL + Angular). macOS, Windows, and Oracle agents push CPU/RAM to `compute_metrics`; workers pull Gemini and Anthropic usage into `api_metrics` / `usage_metrics`; browser extensions estimate web-app usage; the dashboard renders resources dynamically with live WebSocket charts and 7-day/month/year history. A pacing agent and a token-gated dashboard (`DASHBOARD_TOKEN`) are also in place.

**For architecture, repo layout, setup, deployment, and acceptance status, see the [README](README.md).** This document is now the forward-looking roadmap only — everything below is not-yet-built work.

## Design constraints for new work

Anything added here must respect the invariants the platform is built on:

- **Dynamic resource model.** A new data source is added by inserting a row via `POST /api/resources` and pointing a collector at the issued API key — no per-resource routes, no hardcoded frontend panels. Ingest resolves the resource from the key. New integrations (Calendar, Antigravity, finance) must plug in this way.
- **New metric shapes get their own table, not overloaded columns.** `api_metrics` is tokens/cost; `compute_metrics` is CPU/RAM. For a genuinely new shape (time buckets, transactions), follow the migration `002` precedent: widen the `resources.type` CHECK constraint and add a purpose-built table, rather than bending an existing one.
- **Sensitive data stays behind the gate.** Financial data sits behind the existing `DASHBOARD_TOKEN` dashboard gate; encryption-at-rest is still pending and is a prerequisite for storing balances/transactions (see banking-data-hardening notes).

---

## UI/UX

### Rework dashboard UI/UX
The current dashboard is a flat auto-rendered grid of per-resource cards driven by a generic `ResourceComponent` that switches visualization by `type`. That scaled the build but doesn't scale the *reading* — as resource count and data types grow (compute, AI usage, time, finance), a single undifferentiated grid buries the signal.

- **Goals:** a clear information hierarchy (top-level KPI/summary row → grouped sections → per-resource detail), smoother overview↔detail navigation, and one consistent visual system across every chart.
- **Approach:** group resources by domain (Compute · AI Usage · Time · Finance) instead of one flat list; add a summary strip of headline numbers (current spend, active machines, weekly AI burn); unify chart styling, tooltips, and the date-range selector so every panel behaves identically.
- **Theming:** commit to consistent light **and** dark support end-to-end (the roadmap adds more surfaces, so this needs to be systematic, not per-component).
- **Note:** run the design/color work through the `dataviz` guidance when building the new chart system so the palette and mark styles read as one system.

---

## New data sources & integrations

### Google Calendar time analytics
Pull events from Google Calendar and surface how time is actually spent (hours per category/project, meeting load, focus vs. fragmented time).

- **Auth:** reuse the existing Google API/OAuth credentials from the email-labeling and Garmin-watch projects — those are already an approved Google Cloud project with user consent, so no new project or consent screen is needed. Add the `calendar.readonly` scope if it isn't already granted.
- **Collector:** a scheduled `node-cron` worker (`server/src/workers/calendar-time.ts`) that pulls events on an interval and aggregates them daily. Register Calendar as a resource so it flows through the dynamic model.
- **Categorization:** map events → categories via calendar name, event color, and keyword rules (config-driven so rules can change without code edits).
- **Data model:** this is a new shape (time buckets, not tokens/cost), so add a `time_metrics` table (`resource_id`, `day`, `category`, `minutes`, `event_count`) and widen the `resources.type` CHECK to include `calendar`/`time`. Upsert by `(resource, day, category)` for idempotent re-runs.
- **Dashboard:** stacked area/bar of hours-by-category over time, a meeting-load trend, and a focus-time metric derived from gaps between events.
- **Dependency:** Google Calendar connector/authorization must be in place before the worker can pull.

### Antigravity usage
Connect and measure Antigravity usage and ingest it through the dynamic-resource model as an `api`-type resource.

- **Open question first:** determine how Antigravity exposes usage — official API/usage export vs. none. If none, fall back to the same pattern already used for the Gemini web app: a local log/estimator or a proxy/extension that counts request/response activity.
- **Ingest:** whichever source, POST estimates to the existing `/api/ingest/api` endpoint so no backend shape changes are needed.

### RAM analytics
`compute_metrics.memory_bytes` is already collected, so this is primarily a visualization/derivation effort rather than new collection.

- **Build:** RAM-specific charts alongside the existing CPU views — per-machine memory trend and a combined cross-machine view.
- **Gap to close for utilization %:** raw bytes alone can't show "% of RAM used." Have agents also report total physical memory (once, as resource metadata, or as a second column) so the dashboard can plot utilization percentage, not just absolute bytes.

---

## Optimization

### Utilize spare Gemini quota & compute
Put unused Gemini allowance and idle compute to productive use instead of leaving it on the table.

- **Candidate workloads:** the weekly/monthly review bot below, Calendar event categorization, and financial-statement summarization are all batchy, latency-tolerant jobs — good fits for spare capacity.
- **Mechanism:** route these background jobs through Gemini when quota is available, and schedule them on the Oracle server during idle windows. Needs a lightweight way to sense remaining quota/idle capacity before dispatching.
- **Cross-links:** this is the execution substrate for the review bot and can offload the Calendar/finance analysis jobs.

---

## Finance

### Bank connections, budgeting & money analytics
Connect bank accounts and add budgeting, spending analytics, and financial-statement generation.

- **Security prerequisites (blockers):** this is the most sensitive data in the system. It sits behind the existing `DASHBOARD_TOKEN` gate, but **encryption-at-rest must land first**, and the balances feature is still pending (see banking-data-hardening notes). Do not store transactions/balances before encryption-at-rest is in place.
- **Connection:** an aggregation provider (e.g. Plaid) or a comparable method to pull accounts, balances, and transactions.
- **Data model:** new tables for `accounts`, `transactions`, and `budgets` (category, period, limit) — a genuinely new shape, so add tables rather than reusing metrics tables, and widen the resource `type` if accounts are modeled as resources.
- **Analytics:** spending by category, cash flow in/out, net-worth-over-time, budget vs. actual.
- **Statement generation:** monthly income statement and balance sheet generated from the transaction/balance history; the summarization pass can run through spare Gemini/compute.

---

## Automation & reporting

### Local review bot on the Oracle server
A scheduled agent, running locally on the Oracle server, that reviews all collected data and writes a summary report.

- **Cadence:** weekly and monthly runs.
- **Content:** trends, anomalies, and cost/usage highlights across compute, AI usage, time, and (once available) finance.
- **Compute:** leverage spare Gemini/compute per the optimization item; consider whether the existing pacing-agent/scheduling infrastructure can host it rather than standing up a new scheduler.
- **Output:** a Markdown report — decide delivery (surfaced on the dashboard, emailed, or both).

---

## Docs

### Update README
Bring the README in line with the current architecture and the features above — including the parts already built but under-documented (pacing agent, `analytics` route, the `DASHBOARD_TOKEN` dashboard gate, and the full extension set) plus each roadmap feature as it ships.

---

## Suggested order

1. **UI/UX rework** — the foundation the new surfaces render into; doing it first avoids retrofitting every new panel.
2. **RAM analytics** — cheapest win; data already exists, only needs the utilization-% reporting gap closed.
3. **Google Calendar time analytics** — high value, and the OAuth credentials already exist (pending connector authorization).
4. **Review bot + spare-compute plumbing** — build the scheduling/dispatch substrate once, reuse it for finance and Calendar analysis.
5. **Antigravity usage** — gated on the usage-exposure investigation.
6. **Finance** — highest value but blocked on encryption-at-rest; sequence it after the security prerequisite lands.
7. **README** — update continuously as each item ships.
