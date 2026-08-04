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

**Deferred by preference:** the remaining UI/UX work below is intentionally sequenced *after* the new data sources/features. A first polish pass shipped (2026-08-04, see "Shipped so far"), and I'd rather build out the other roadmap features next and return to further UX/UI changes afterward. New panels added in the meantime should still follow the shipped two-column layout and chart conventions so there's less to retrofit later.

### Rework dashboard UI/UX
The dashboard started as a flat auto-rendered grid of per-resource cards driven by a generic `ResourceComponent` that switches visualization by `type`. That scaled the build but doesn't scale the *reading* — as resource count and data types grow (compute, AI usage, time, finance), a single undifferentiated grid buries the signal.

**Shipped so far (2026-08-04):**
- **Two-column overview.** The headline analytics graph (weekly usage % per resource) is now the main show on the left ~2/3 with the week-over-week / month-over-month comparison table stacked directly below it; per-resource cards moved to a stacked right ~1/3 rail. Container widened (1200→1600px) to cut the empty side gutters. The old table/graph toggle and the S/M/L card-sizing are gone; drag-to-reorder and expand/collapse remain.
- **Utilization-positive delta colors.** Period-over-period arrows now read increase = green (good), decrease = red — using more of a resource than the previous period is the win on a utilization dashboard.
- **Pace instead of raw % for subscription graphs.** Claude/Gemini usage trends now plot *pace* (utilization ÷ fraction-of-week-elapsed; 100% = on track) rather than raw utilization, so the line no longer sawtooths down to 0 at each weekly reset. Includes a dashed on-pace guide line, a gauge pace readout, and a new `pace_avg`/`pace_max` on the server's `GET /api/metrics/usage/bucketed` for the month/year views.

**Still to do (return to after other features):**
- **More UX/UI changes** the user has in mind, to be specified when we come back to this.
- **Goals:** a clear information hierarchy (top-level KPI/summary row → grouped sections → per-resource detail), smoother overview↔detail navigation, and one consistent visual system across every chart.
- **Approach:** group resources by domain (Compute · AI Usage · Time · Finance) instead of one flat list; add a summary strip of headline numbers (current spend, active machines, weekly AI burn); unify chart styling, tooltips, and the date-range selector so every panel behaves identically.
- **Theming:** commit to consistent light **and** dark support end-to-end (the roadmap adds more surfaces, so this needs to be systematic, not per-component).
- **Note:** run the design/color work through the `dataviz` guidance when building the new chart system so the palette and mark styles read as one system.

---

## New data sources & integrations

### Google Calendar time analytics — ✅ shipped (2026-08-04)
Reads the 7 life-domain calendars (the ones the Garmin watch app writes into) and
surfaces how time is actually spent. Because these are single-active-domain time
logs rather than a meeting schedule, we built domain-appropriate metrics instead
of the originally-sketched "meeting load / focus-from-gaps".

**Shipped:**
- **Read-only OAuth collector.** A Node port of the Garmin app's auth: `server/scripts/authorize-calendar.mjs` mints a `calendar.readonly` refresh token (reusing the existing Google Cloud OAuth client), stored in a gitignored `server/config/` file; the worker refreshes it silently (`google.auth.fromJSON` → `UserRefreshClient`). The claude.ai connector can't drive a headless cron, so the collector holds its own token.
- **Collector + data model.** `server/src/workers/calendar-time.ts` (a `node-cron` pull worker, `googleapis` dynamically imported so it's optional) reads each calendar, splits events at **local-timezone midnight**, and aggregates minutes + event_count per `(day, category)` into a new `time_metrics` table (migration `003_time.sql`; `resources.type` CHECK widened to `calendar`). Runs are idempotent (delete-then-insert over a rolling window); `npm run backfill:calendar` loads history. The resource auto-registers via `ensureCalendarResource`.
- **Categorization = 1 calendar : 1 category.** Config-driven in `server/config/calendars.json` (`id`, `category`, `tier`); `calendars.example.json` is the committed placeholder. `tier` groups domains into productive / neutral / low-value.
- **Read + analytics routes.** `GET /api/metrics/time` (+ `/bucketed`); `/api/analytics/summary` gained a calendar case (tracked hours + productive hours WoW/MoM), and the headline `weekly-usage` overlay now includes Time as weekly **productive-share %**.
- **Dashboard panel.** `calendar-panel.component.ts`: stacked hours-by-domain (7d/Month/Year), a productive-vs-waste **quality-mix** bar, **day fragmentation** (switches/day stat + per-bucket in the tooltip), and a per-domain **WoW/MoM + longest-streak** table. Colors use a dataviz-validated CVD-safe categorical palette; follows the shipped card/two-column conventions.

**Deferred (by preference):** no live "what am I doing now" widget and no untracked/gap-time metric; the panel follows the platform-wide dark-only styling until the deferred light/dark theming pass.

**One-time setup before it collects:** run the authorize script (browser), copy the token to the server, drop in the real `calendars.json`, then `npm run backfill:calendar`. Publish the OAuth consent screen ("In production") or the refresh token expires after ~7 days.

### Antigravity usage
Connect and measure Antigravity usage and ingest it through the dynamic-resource model as an `api`-type resource.

- **Open question first:** determine how Antigravity exposes usage — official API/usage export vs. none. If none, fall back to the same pattern already used for the Gemini web app: a local log/estimator or a proxy/extension that counts request/response activity.
- **Ingest:** whichever source, POST estimates to the existing `/api/ingest/api` endpoint so no backend shape changes are needed.

### RAM analytics — ✅ shipped (2026-08-04)
`compute_metrics.memory_bytes` was already collected; this was primarily a derivation/visualization effort.

**Shipped:**
- **Utilization-% gap closed.** Agents now report `memory_total_bytes` (total usable RAM: `os.totalmem()` on Node agents, `TotalVisibleMemorySize` on Windows). Ingest stores it once as `resources.metadata.memory_total_bytes` — no schema migration, and only rewritten when it actually changes — so the dashboard has a denominator for "% of total RAM."
- **Per-machine chart.** The existing compute chart keeps its CPU% (left) + memory-in-GB (right) lines; the memory tooltip now also shows RAM as a % of total (`10.1 GB (63% of 16 GB)`) and the caption shows total RAM. Falls back to GB-only until a machine has reported its total.
- **Combined cross-machine view.** A new "RAM utilization" panel on the overview overlays every machine's weekly RAM% (`GET /api/analytics/memory-usage`), reusing the Usage-trends chart's visual system (0–100% axis, per-machine colors). Machines with no reported total are omitted.

**Deferred:** the "Performance vs. previous period" table still shows memory in GB (the WoW/MoM arrows are identical in GB or %); a fine-grained range selector on the cross-machine graph (it follows the weekly convention for now).

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
Bring the README in line with the current architecture and the features above — including the parts already built but under-documented (pacing agent, `analytics` route, the `DASHBOARD_TOKEN` dashboard gate, the full extension set, and now the **Google Calendar time-analytics collector** — the `calendar` resource type, `time_metrics` table, `authorize-calendar` / `backfill:calendar` scripts, and `server/config/calendars.json` setup) plus each roadmap feature as it ships.

---

## Suggested order

The first UI/UX polish pass has shipped (see UI/UX section); **further UI/UX changes are deliberately deferred to after the feature work** per the user's preference.

1. **RAM analytics** — ✅ shipped (2026-08-04). Utilization-% gap closed via agent-reported total RAM; per-machine RAM% (tooltip/caption) and a cross-machine RAM% overlay.
2. **Google Calendar time analytics** — ✅ shipped (2026-08-04). Read-only OAuth collector → `time_metrics`; per-domain hours, quality mix, fragmentation, and WoW/MoM + streaks panel.
3. **Review bot + spare-compute plumbing** — build the scheduling/dispatch substrate once, reuse it for finance and Calendar analysis.
4. **Antigravity usage** — gated on the usage-exposure investigation.
5. **Finance** — highest value but blocked on encryption-at-rest; sequence it after the security prerequisite lands.
6. **Further UI/UX rework** — the deferred hierarchy/grouping/summary-strip/theming work plus the user's additional changes; do it once the new surfaces exist so it's one consistent pass, not per-panel. New panels built before then should follow the shipped conventions to limit retrofitting.
7. **README** — update continuously as each item ships.
