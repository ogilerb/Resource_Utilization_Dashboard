# Telemetry Aggregation Platform — Roadmap

## Current state

The core platform is **built and running**. The aggregator runs on the Oracle Cloud server (Node/Express + PostgreSQL + Angular). macOS, Windows, and Oracle agents push CPU/RAM to `compute_metrics`; workers pull Gemini and Anthropic usage into `api_metrics` / `usage_metrics`; browser extensions estimate web-app usage; the dashboard renders resources dynamically with live WebSocket charts and 7-day/month/year history. A pacing agent and a token-gated dashboard (`DASHBOARD_TOKEN`) are also in place.

**For architecture, repo layout, setup, deployment, and acceptance status, see the [README](README.md).** This document is now the forward-looking roadmap only — everything below is not-yet-built work.

**Current priorities (2026-09-13):** [Inventory](#inventory) and [Finance](#finance) — tracking my stuff and my bank transactions, with the two joined by a transaction → item link. **Low upkeep per action is the governing principle for both:** tracking only survives if adding, moving, or explaining something takes a paste or a click.

## Design constraints for new work

Anything added here must respect the invariants the platform is built on:

- **Dynamic resource model.** A new data source is added by inserting a row via `POST /api/resources` and pointing a collector at the issued API key — no per-resource routes, no hardcoded frontend panels. Ingest resolves the resource from the key. New integrations (Calendar, Antigravity, finance) must plug in this way.
- **Feature-level resources, not row-level.** A domain like Finance or Inventory auto-registers **one** `resources` row (type `finance` / `inventory`) so the overview card, detail page, and liveness badge work for free. Individual bank accounts or inventory items are never resources.
- **New metric shapes get their own table, not overloaded columns.** `api_metrics` is tokens/cost; `compute_metrics` is CPU/RAM. For a genuinely new shape (time buckets, transactions), follow the migration `002` precedent: widen the `resources.type` CHECK constraint and add a purpose-built table, rather than bending an existing one.
- **Table families get a prefix in `public`, not a Postgres schema.** `inv_*` for inventory, `fin_*` for finance. Use `text` + `CHECK` instead of `CREATE TYPE` enums (matches `resources.type`, stays idempotent, widens with the known DROP/ADD CONSTRAINT dance). Migrations stay forward-only numbered SQL in `server/migrations/`.
- **AI assistance is a copy/paste loop, not a server dependency.** *(Decided 2026-09-13.)* The server exposes **prompt builders** (`GET …/prompt`) and **structured import endpoints** with a dry-run preview; I paste the prompt into claude.ai/ChatGPT and paste its JSON back. No LLM SDK or API key on the server.
- **Sensitive data stays behind the gate, and is encrypted at rest.** Financial data sits behind the `DASHBOARD_TOKEN` gate; sensitive columns (bank/Plaid tokens, balances) must additionally be run through `server/src/lib/crypto.ts` (`encrypt`/`decrypt`, keyed by `DATA_ENCRYPTION_KEY`) before they touch Postgres. The encryption module and surrounding hardening (hashed API keys, CSP/HSTS, auth rate-limiting, tightened CORS, validated DB TLS) shipped 2026-08-13; what remains is operational (set the key, enable TLS, encrypt the DB volume). See banking-data-hardening notes.

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
- **Cross-links:** this is the execution substrate for the review bot and can offload the Calendar/finance analysis jobs. *(Inventory dictation parsing and transaction → item extraction deliberately do **not** use this — they're the copy/paste loop per the design constraints.)*

---

## Inventory

### Goal
Postgres becomes the system of record for my home inventory (the 632-item `Inventory_Of_Things.xlsx`). After a one-time import, the everyday actions must each be a paste or a click:

| Action | How it happens |
|---|---|
| **Bulk add** a pile of stuff | Dictate on my phone → paste transcript → **Copy prompt** → paste into an LLM → paste JSON back → preview → **Commit** |
| **Move** things | Same loop with the *move* intent ("moved the label maker and HDMI cables to the closet bin"), **or** a one-click Move quick action on an item row |
| **Revalue / dispose / log a use** | Quick action on the row, or an `update` / `dispose` / `log_use` op in a pasted batch |
| **Add what I just bought** | From the Finance review inbox — see [Transaction → inventory loop](#transaction--inventory-loop) |

**Source spec:** `inventory_postgres_migration_spec.md`. Its sections 2–5 (source profile, schema, transformation rules, acceptance checks, views) are the data-rule reference. Its sections 6–8 (Python, Alembic, `inventory` schema, `down` migrations, plpgsql helpers) are superseded by the repo adaptations below.

### Schema — `server/migrations/005_inventory.sql` *(new)*
- **Tables** from spec §3 with the `inv_` prefix: `inv_locations`, `inv_containers` (self-referential `parent_id` for `bag → plastic bag`), `inv_categories`, `inv_items`, `inv_item_valuations`, `inv_item_usage_events`, `inv_packing_lists`, `inv_packing_list_items`. **Views** from spec §5 as `inv_v_items`, `inv_v_value_by_location`, `inv_v_value_by_category`, `inv_v_item_utilization`, `inv_v_packing_status`.
- **Extensions:** `pg_trgm` (fuzzy name matching) and `citext` (case-insensitive lookups), created inline like `pgcrypto` in `004`.
- **Adaptations:** enums → `text CHECK (...)` (`status`, `grade`, packing `status`); triggers via `CREATE OR REPLACE TRIGGER` so the file is re-runnable; extra columns `inv_items.source` (`xlsx | import | quick`) and `inv_items.disposed_reason`.
- **Valuation history accrues automatically:** a trigger on `UPDATE OF est_value_cad` appends an `inv_item_valuations` row when the value actually changes. Insert paths (XLSX script, import API) write their own `initial_import` / `import` row so there's never a duplicate.
- **Idempotent imports:** `inv_import_batches (batch_id uuid PK, intent text, ops jsonb, result jsonb, committed_at timestamptz)`.
- **Resource type:** widen `resources_type_check` to add `'inventory'`.
- **No FK from items to `resources`** — items aren't telemetry sources; the single `inventory` resource row is a feature-level card.
- **Purchase link:** a nullable `inv_items.purchase_transaction_id` (one transaction → many items, e.g. an Amazon order). The column is added in `006_finance.sql` because it references `fin_transactions`.
- **Not built:** the spec's `add_item` / `log_use` plpgsql helpers. The import API is the **single write path**; a second one is upkeep.

### One-time XLSX import — `server/scripts/import-inventory-xlsx.mjs` *(new)*
- **Library:** `exceljs` — it exposes cell fill colours (needed for the green "new addition" rows); SheetJS community edition does not.
- **CLI:** `--xlsx PATH [--dry-run] [--truncate]`; `npm run import:inventory`. Single transaction; upsert on `legacy_ref` and lookup names so reruns don't duplicate. Follows the `.mjs` + usage-docblock style of `sync-calendar-colors.mjs`; Docker invocation mounts the file read-only.
- **Applies every spec §4 rule:** select sheet by index 0 (em dash in its name), stop at the first blank `Item`, split categories on `' / '` only, `→` container nesting, grade substring table, keep en/em dashes, `University Move` packing list with section headers, `#467`/`#495` → `undecided`.
- **Fill check:** `cell.fill?.type === 'pattern' && cell.fill.fgColor?.argb === 'FFE2EFDA'` must hit **exactly 12** rows or the script exits non-zero.
- **Ends by asserting the spec's acceptance counts:** 632 items · sum 10,895.35 · 470 valued > 0 · 12 new additions · 14 locations · 183 categories · ≥ 24 containers · max `legacy_ref` 633 · 210 `pack` rows · 2 unresolved packing refs (`45+`, `62+`).
- **Housekeeping:** add `*.xlsx` to `.gitignore`; archive the original file outside the repo, unmodified.

### Import API — the AI copy/paste loop *(new)*
Files: `server/src/routes/inventory.ts`, `server/src/lib/inventoryResolve.ts`, `server/src/lib/inventoryPrompt.ts`. Mounted in `app.ts` alongside the other gated routes (`authLimiter` + `requireDashboardAuth`).

**`GET /api/inventory/prompt?intent=add|move|review[&transaction_ids=…]` → `{ prompt }`.** Built fresh from the DB each time, so the LLM always sees current names:
1. Rules: use location/container/category names **exactly as listed**; leave `category` null if unsure; one op per item; split "two HDMI cables and a charger" into separate ops; output **only** the JSON object.
2. The op schema for that intent (only the ops it needs).
3. Canonical lists: locations, containers with their location, categories.
4. For `review`: the selected transactions (`id, date, merchant, amount, my note`) with "emit `add` ops carrying `transaction_id`".
5. Ends with `Transcript:` — **the browser appends my dictation locally**, so the server never stores raw transcripts and this endpoint stays a pure read.

**What the LLM returns — small and forgiving.** Names, not ids; only `op` plus an item name is required:
```json
{ "ops": [
  { "op": "add", "name": "Label maker", "quantity": 1, "location": "Room – Desk (top)", "container": null,
    "category": "Electronics / Office", "condition": "Good", "est_value_cad": 45, "notes": null, "transaction_id": null },
  { "op": "move",    "item": "HDMI cables", "location": "Closet", "container": "Closet bin" },
  { "op": "update",  "item": "Label maker", "est_value_cad": 30, "condition": "Fair" },
  { "op": "dispose", "item": "Old router", "how": "donated", "on": "2026-09-13" },
  { "op": "log_use", "item": "Label maker", "on": "2026-09-13" }
]}
```
Zod discriminated union on `op`. Every name field has an optional `*_id` twin (`item_id`, `location_id`, …) that wins when present — that's how the preview pins an ambiguous choice without a second schema.

**`POST /api/inventory/import`** — body `{ batch_id: uuid, intent: 'add'|'move'|'review'|'quick', dry_run: boolean, allow_new?: { locations?, containers?, categories? }, ops: Op[] }`, capped at 500 ops (≈100 KB, inside the existing 256 KB body limit).
- **Name resolution** (per item/location/container/category): exact `citext` match → `matched`; best `similarity()` ≥ 0.6 with a ≥ 0.15 lead → `fuzzy` (auto-accepted, shown in preview); ≥ 2 candidates ≥ 0.45 with no clear winner → `ambiguous` (returns candidates with their location/container, so "HDMI cable" vs "HDMI cable (long)" is a dropdown pick); nothing close → `new`. Item matching only considers `owned | stored | packed` items; containers resolve within the op's location first, then globally.
- **Auto-create policy (low upkeep, but locations stay curated):** new containers and categories are created automatically (containers under the op's location; categories split on `' / '` like the importer). A **new location blocks the op** until I tick "create location X" in the preview, which resubmits with `allow_new.locations`.
- **Dry run** (`dry_run: true`) writes nothing and returns per-op `{ status: ok|blocked, resolutions }` plus a batch `summary` and `will_create` lists.
- **Commit** (`dry_run: false`) runs in one transaction. Any blocked op → `409` with the preview, nothing written. `INSERT … ON CONFLICT (batch_id) DO NOTHING` makes retries safe: a replayed batch returns the stored result with `already_committed: true`. Ops apply as insert-item + valuation (`add`), location/container update (`move`), partial update (`update`, valuation trigger fires), status + `disposed_on` + reason (`dispose`), usage event (`log_use`); `transaction_id` sets `purchase_transaction_id`. First commit calls `ensureInventoryResource()`.

**Reads for the UI:** `GET /api/inventory/items?q&location&category&status&limit` (reads `inv_v_items`; full-text on `search_tsv` or trigram on name), `GET /api/inventory/lookups`, `GET /api/inventory/summary` (item count, total value, value by location/category, needs-appraisal, dormant assets, last import).

### Dashboard — `/inventory` page + overview card *(new)*
- **Route + nav:** add `inventory` to `app.routes.ts` and a nav link.
- **`inventory-page`** — the shipped two-column layout: capture + import on the left, summary KPIs + item list on the right. Reads `?intent=review&transactions=…` for the hand-off from Finance.
- **`inventory-capture`** — transcript textarea, add/move intent toggle, **Copy prompt** (fetches the prompt, appends the transcript, writes to the clipboard, shows "Paste into Claude/ChatGPT, then paste its JSON below").
- **`inventory-import`** — paste box that tolerates ```` ```json ```` fences; generates `batch_id = crypto.randomUUID()` once per paste; dry-run preview table with status pills (matched / fuzzy / new / ambiguous / blocked), a candidate `<select>` on ambiguous cells, a "create location X" toggle; **Commit N ops** reuses the same `batch_id` so a network retry can't double-insert.
- **`inventory-list`** — debounced search, location/category/status filters; row quick actions **Move** (location + container selects), **Log use**, **Dispose** — each posts a single-op `quick` batch to the same import endpoint.
- **`inventory-panel [resource] [compact]`** — overview card and `/resource/:id`: compact = items, total value, last import; expanded = value-by-location bars, needs-appraisal and dormant counts, link to `/inventory`.
- **Resource wiring:** `'inventory'` in the `ResourceType` unions (dashboard `models.ts`, server `auth.ts` + `resources.ts` zod enum), `@case ('inventory')` in `overview.component.ts` and `resource-detail.component.ts`, liveness arm `max(committed_at) FROM inv_import_batches` in the `GET /api/resources` CASE. `interval_seconds = 604800`, so the card goes "offline" after ~3 weeks without an import — a gentle nudge.

### Deferred
- **In-browser dictation button** (`webkitSpeechRecognition`, `en-CA`) on the capture box, skipping the phone → paste step. No CSP change needed.
- Packing-list UI (the list is imported and queryable; no screen yet), usage-tracking UI beyond `log_use`, the spec's `export_inventory` xlsx backup script.

### Risks
- `exceljs` only reports `pattern` fills with `argb`; theme/indexed colours come back differently. The "exactly 12 green rows" assertion is the guard.
- Money: `pool.ts` parses NUMERIC into JS numbers — do sums and rounding in SQL (`round(sum(...), 2)`), never in JS. DATE columns come back as JS Dates — read them with `to_char(..., 'YYYY-MM-DD')` like `metrics.ts`.
- `resetDb()` in `server/test/helpers.ts` only truncates `resources … CASCADE`; the `inv_*` tables have no FK to it, so extend the truncate list.

---

## Finance

### Bank connections via Plaid, transaction review inbox & money analytics
Pull my bank transactions in automatically, ask me about the ones that aren't obvious, learn from my answers, and feed purchases into the inventory.

- **Security prerequisites:** this is the most sensitive data in the system. The one-time hardening is now in place (2026-08-13): app-level column encryption (`lib/crypto.ts`), hashed API keys, CSP/HSTS headers, auth rate-limiting, tightened CORS, validated DB TLS. **Before storing anything:** (1) set `DATA_ENCRYPTION_KEY` and run every Plaid `access_token`, account identifier, and balance through `encrypt()`; (2) serve over TLS; (3) encrypt the Oracle volume. Keep aggregatable, low-sensitivity fields in cleartext so analytics still work — encrypt only the truly sensitive columns (boundary below).
- **Connection:** **Plaid live sync** *(decided 2026-09-13)* — Plaid Link in the dashboard, cursor-based `/transactions/sync` on a cron. Canadian accounts, CAD.

### Schema — `server/migrations/006_finance.sql` *(new)*
Widen `resources_type_check` to add `'finance'`, then:

| Table | Holds |
|---|---|
| `fin_connections` | One per Plaid Item (a bank login): `plaid_item_id`, **`access_token_enc`**, institution id/name, `sync_cursor`, `status` (`active` / `login_required` / `error` / `removed`), `last_error`, `last_synced_at` |
| `fin_accounts` | `plaid_account_id`, name, type/subtype, currency, **`mask_enc`**, **`balance_current_enc`**, **`balance_available_enc`**, `balance_updated_at` |
| `fin_balance_snapshots` | `(account_id, day)` → **`current_enc`**, **`available_enc`** — net-worth history |
| `fin_transactions` | Plaid fields: `plaid_transaction_id UNIQUE`, `pending_transaction_id`, `pending`, `amount numeric(12,2)` (Plaid sign: positive = money out), `date`, `authorized_date`, `name`, `merchant_name`, `merchant_entity_id`, `merchant_key citext`, `pfc_primary`, `pfc_detailed`, `pfc_confidence`, `payment_channel`, `removed_at`, `raw jsonb`. My fields: `category_override`, `note`, `is_purchase_of_items`, `review_status` (`none` / `pending` / `answered` / `skipped`), `review_reasons text[]`, `review_question`, `reviewed_at` |
| `fin_merchant_rules` | Learned answers: `merchant_key UNIQUE`, `category`, `is_purchase_of_items`, `always_ask`, `note`, `times_applied` |
| `fin_sync_runs` | Sync log (`added/modified/removed`, error, started/finished) — drives liveness |

Plus `ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS purchase_transaction_id bigint REFERENCES fin_transactions(id) ON DELETE SET NULL` (indexed). Budgets (`fin_budgets`) are deferred.

**Encryption boundary.** Encrypted: access tokens, account masks, balances (live and snapshots). **Cleartext: transaction amount, date, merchant, and categories.** This refines the earlier "amount sign only" wording on purpose: category spend, cash flow, the threshold rule, and the review inbox are all SQL aggregates over `amount`, and a transaction row with no account identifiers is far less sensitive than a token or a balance. Net worth is computed in the app after decrypting the few balance rows. The finance router calls `requireEncryption()` when it mounts (503 if unset); the worker bails with a log if `!encryptionConfigured()`.

### Config, client, routes
- **Config** (`server/src/config.ts`; mirror in `docker-compose.yml` and `server/.env.example`): `plaid: { clientId: PLAID_CLIENT_ID, secret: PLAID_SECRET, env: PLAID_ENV='sandbox', countryCodes: PLAID_COUNTRY_CODES='CA', redirectUri: PLAID_REDIRECT_URI, daysRequested: 365, cron: PLAID_SYNC_CRON='0 */6 * * *', resourceName: FINANCE_RESOURCE_NAME='Finance' }` and `financeReview: { amountThreshold: FINANCE_REVIEW_AMOUNT_CAD=40, merchantMinSeen: 2 }`.
- **Client:** `plaid` npm SDK, dynamically imported in `server/src/lib/plaidClient.ts` (same optional-dependency posture as `googleapis`).
- **Routes** — `server/src/routes/finance.ts`, gated like the others:
  - `POST /api/finance/link-token` — `linkTokenCreate` (products `transactions`, `CA`, `days_requested`); passing a `connection_id` gives update mode for re-auth.
  - `POST /api/finance/exchange` — `itemPublicTokenExchange` → `encrypt(access_token)` → `fin_connections` → `accountsGet` → `fin_accounts` → kick off a sync.
  - `GET /api/finance/accounts` — decrypted masks + balances.
  - `GET /api/finance/transactions?from&to&account_id&q` — includes linked `items[]`.
  - `GET /api/finance/review?status=pending&days=30` and `POST /api/finance/review/:id/answer` — the inbox (below).
  - `GET /api/finance/summary?months=3` — spend by `coalesce(category_override, pfc_primary)` this vs last month, money in/out per month, net worth, pending-review count, last sync.
  - `POST /api/finance/sync` — manual trigger (needed in sandbox).

### Sync worker — `server/src/workers/plaid-sync.ts` *(new)*
Registered in `workers/index.ts` with `enabled: Boolean(config.plaid.clientId && config.plaid.secret)`, modelled on `calendar-time.ts`.
- For each active connection: decrypt the token, loop `transactionsSync({ access_token, cursor, count: 500 })` until `has_more` is false.
- Each page in one DB transaction: upsert `added ∪ modified` with `ON CONFLICT (plaid_transaction_id) DO UPDATE` on **Plaid fields only** (never my note/category/review fields); `removed` → set `removed_at` (soft delete, so item links survive); then save `next_cursor`.
- **Pending → posted:** when a posted row arrives with `pending_transaction_id`, copy my fields from the pending row, re-point `inv_items.purchase_transaction_id`, and soft-remove the pending row.
- **Errors:** `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` → restart from the cursor saved at run start; `ITEM_LOGIN_REQUIRED` → `status = 'login_required'` and a "Reconnect" button in the UI.
- **After paging:** apply merchant rules + flagging to newly posted rows, take a daily `accountsBalanceGet` snapshot, write a `fin_sync_runs` row, call `ensureFinanceResource()` (`interval_seconds = 21600`, so "online" = synced within ~18h). Generalise `upsertResource.ts` into `ensureResource(name, type, intervalSeconds)` and keep the existing helpers as thin wrappers.

### Review inbox — "what was this?" *(new)*
Rules live in `server/src/lib/financeReview.ts` as pure functions (unit-testable). No LLM: questions are templates. `merchant_key` = lower-cased `merchant_entity_id`, else `merchant_name`, else `name`, with store numbers (`#1234`) stripped.

**Never ask about:** pending transactions (wait until posted); credits/refunds (`amount < 0`); `pfc_primary` in `TRANSFER_IN`, `TRANSFER_OUT`, `LOAN_PAYMENTS`, `INCOME`, `BANK_FEES`, `RENT_AND_UTILITIES`; or any merchant with a learned rule where `always_ask = false` (apply its category, bump `times_applied`).

**Ask when** (every matching reason is recorded; the question comes from the highest-priority one):

| # | Reason | Rule | Question |
|---|---|---|---|
| 1 | `large` | `amount ≥ $40` (configurable) | "**$62.40 at Canadian Tire on Sep 11** — what was it, and is there anything to add to the inventory?" |
| 2 | `purchase_merchant` | learned rule with `always_ask = true` (Amazon-type stores) | "**Amazon, $38.12, Sep 10** — what did you buy?" |
| 3 | `new_merchant` | merchant seen fewer than 2 times before | "First time seeing **{merchant}** ({amount}, {date}). What was it?" |
| 4 | `ambiguous_category` | `pfc_primary` in `GENERAL_MERCHANDISE`, `GENERAL_SERVICES`, `HOME_IMPROVEMENT`, or missing | "**{merchant}** ({amount}, {date}) is filed as '{detailed category}'. What was it — something you kept?" |
| 5 | `low_confidence` | `pfc_confidence` is `LOW` / `UNKNOWN` / missing | "Plaid isn't sure about **{name}** ({amount}, {date}). What was it?" |

**Answering** — `POST /api/finance/review/:id/answer` `{ note?, category?, is_purchase_of_items?, remember_merchant = true, skip? }`:
- Sets my fields and `review_status = answered | skipped`.
- With `remember_merchant`, upserts `fin_merchant_rules` with `always_ask = is_purchase_of_items`. **This is what keeps upkeep low:** "Tim Hortons → Food" is never asked again, while "Amazon → always ask what I bought" keeps prompting because the answer differs every time.
- **UI:** the inbox on `/finance` is grouped by day (that grouping *is* the daily list of questions). Each row has one-click chips — *Food & drink, don't ask again* · *Bought stuff for the inventory* · *Skip* — plus a free-text note ("drill and a box of screws") and a category picker. Email/push delivery is deferred.

### Transaction → inventory loop
1. In the inbox I answer purchases with *Bought stuff* and a short note of what it was.
2. **Build inventory prompt** is enabled for answered rows with `is_purchase_of_items = true` and no linked items; it opens `/inventory?intent=review&transactions=…`.
3. The capture box fetches `GET /api/inventory/prompt?intent=review&transaction_ids=…` — the prompt already contains each transaction's id, date, merchant, amount, and my note. I can add extra dictation.
4. The LLM returns `add` ops carrying `transaction_id`; the normal preview → commit sets `inv_items.purchase_transaction_id`.
5. The inbox/transaction row shows "N items linked"; pending → posted syncs re-point the link.

### Dashboard — `/finance` page + overview card *(new)*
- **`plaid-link.service.ts`** injects `https://cdn.plaid.com/link/v2/stable/link-initialize.js` once and opens `Plaid.create({ token, onSuccess → /exchange })`.
- **`finance-page`**: Connect bank / Reconnect, accounts with balances, review inbox, transactions table with linked items, **Build inventory prompt**.
- **`finance-panel [resource] [compact]`**: month-to-date spend vs last month, pending reviews, last sync. Wired the same way as inventory (`ResourceType` unions, `@case ('finance')`, liveness arm `max(finished_at) FROM fin_sync_runs`).
- **CSP change required.** Both `dashboard/nginx.conf` and `deploy/nginx.conf` set `script-src 'self'` with no `frame-src`, which blocks Link's script and iframe. Add `https://cdn.plaid.com` to `script-src` and a `frame-src https://cdn.plaid.com`, plus any `connect-src` hosts Plaid's current Link CSP docs list; keep the two files identical. `ng serve` has no CSP, so local dev works either way. Fallback that needs no CSP change: Plaid **Hosted Link** (open a Plaid-hosted URL in a new tab).

### Analytics
Spending by category, cash flow in/out, net worth over time (decrypt snapshots in the app; cap rows for the year view), and budget vs. actual once `fin_budgets` exists. Monthly income statement / balance sheet generation stays a later item.

### Environments
Sandbox first (`PLAID_ENV=sandbox`, a sandbox institution with `user_good` / `pass_good`, `/sandbox/public_token/create` for headless tests) → production for my real accounts once Plaid approves production access (their free limited-production allowance covers personal use).

### Risks
- **Plaid production approval and Canadian bank OAuth.** Production needs an application in the Plaid dashboard, and OAuth institutions need a registered https `PLAID_REDIRECT_URI`. Sandbox proves the pipeline, but real-bank onboarding can lag.
- **Encrypted balances can't be aggregated in SQL** — fine at personal scale, but net-worth charts decrypt per request.
- **CSP drift** between the two nginx files.
- **Plaid doesn't always set `pending_transaction_id`** — unmatched pending rows that get removed stay soft-deleted (and keep any item links) rather than vanishing.

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
Bring the README in line with the current architecture and the features above — including the parts already built but under-documented (pacing agent, `analytics` route, the `DASHBOARD_TOKEN` dashboard gate, the full extension set, and now the **Google Calendar time-analytics collector** — the `calendar` resource type, `time_metrics` table, `authorize-calendar` / `backfill:calendar` scripts, and `server/config/calendars.json` setup) plus each roadmap feature as it ships:
- **Inventory:** `npm run import:inventory`, the `/inventory` capture → prompt → paste JSON → preview → commit loop, the import JSON op format, and quick actions.
- **Finance:** Plaid env vars, the nginx CSP additions, the sandbox → production flow, the encryption boundary, and how the review inbox learns merchant rules.

---

## Known bugs

- **Reloading on any page other than the overview shows nothing.** Noted in this file *after* `52292cf` added `<base href="/">` to `index.html`, and both nginx configs already have the `try_files … /index.html` SPA fallback, so the cause isn't obvious. Reproduce on the deployed build and under `ng serve` (e.g. reload `/resource/:id` and `/register`), then fix and delete this entry. Check it before adding the `/inventory` and `/finance` routes, which would inherit it.

---

## Suggested order

The first UI/UX polish pass has shipped (see UI/UX section); **further UI/UX changes are deliberately deferred to after the feature work** per the user's preference. **Inventory and Finance are the current priorities (2026-09-13).** Inventory goes first because it has no third-party dependency and delivers value immediately.

1. **RAM analytics** — ✅ shipped (2026-08-04). Utilization-% gap closed via agent-reported total RAM; per-machine RAM% (tooltip/caption) and a cross-machine RAM% overlay.
2. **Google Calendar time analytics** — ✅ shipped (2026-08-04). Read-only OAuth collector → `time_metrics`; per-domain hours, quality mix, fragmentation, and WoW/MoM + streaks panel.
3. **Inventory M1 — schema + XLSX import.** `005_inventory.sql`, `import-inventory-xlsx.mjs`. *Done when:* `npm run migrate` twice is a no-op; `--dry-run` prints counts; the real run passes every acceptance count; a rerun changes nothing.
4. **Inventory M2 — import API + prompt builder.** *Done when* `server/test/inventory.test.ts` covers: dry-run statuses (exact / fuzzy / new / ambiguous with two near-identical item names); blocked new location vs `allow_new.locations`; commit writes items + `import` valuations; replaying a `batch_id` returns `already_committed` with no duplicates; `move`, `update` (trigger adds a valuation row), `dispose`, `log_use`; the prompt contains seeded lookup names; the 500-op cap; 409 on a blocked commit. Extend `resetDb()` for `inv_*`.
5. **Inventory M3 — `/inventory` UI + overview card.** *Done when,* in the browser: paste a dictated transcript → Copy prompt → paste the LLM's JSON → preview shows the expected statuses → Commit → list and card update; a quick-action Move works with no LLM involved.
6. **Finance M4 — Plaid sandbox end to end.** `006_finance.sql`, config, `plaidClient.ts`, routes, `plaid-sync.ts`, CSP change, `/finance` page with Link. *Done when:* `server/test/finance-sync.test.ts` runs the page-apply logic on fixture JSON with no network (added / modified / removed, pending → posted carry-over and item re-pointing, my fields preserved on modify); a sandbox smoke script (`/sandbox/public_token/create` → `/exchange` → `/sync`) loads transactions; in the browser, Connect bank with `user_good` / `pass_good` shows transactions and decrypted balances and the Finance card goes online. Then apply for production and connect my real accounts. **Operational gates still apply:** set `DATA_ENCRYPTION_KEY`, enable TLS, encrypt the volume.
7. **Finance M5 — review inbox + merchant rules.** *Done when* `server/test/finance-review.test.ts` covers each flag rule and the never-ask set; an answer creates a rule so the same merchant on the next fixture page is auto-categorised and not asked; an `always_ask` merchant is still asked; skip works.
8. **M6 — transaction → inventory link.** `intent=review` prompt, `transaction_id` on `add`, "N items linked" in the inbox, Build inventory prompt button. *Done when* an import with `transaction_id` sets the FK, a pending → posted sync re-points it, and `GET /api/finance/transactions` returns the linked items.
9. **Review bot + spare-compute plumbing** — build the scheduling/dispatch substrate once, reuse it for finance and Calendar analysis.
10. **Antigravity usage** — gated on the usage-exposure investigation.
11. **Follow-ups** — in-browser dictation button, `fin_budgets` + budget vs actual, inbox notification delivery, statement generation.
12. **Further UI/UX rework** — the deferred hierarchy/grouping/summary-strip/theming work plus the user's additional changes; do it once the new surfaces exist so it's one consistent pass, not per-panel. New panels built before then should follow the shipped conventions to limit retrofitting.
13. **README** — update continuously as each item ships (at minimum after M1, M3, and M4).
