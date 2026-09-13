# Inventory: XLSX → PostgreSQL Migration Spec

**Source:** `Inventory_Of_Things.xlsx`
**Target:** PostgreSQL schema `inventory`, integrated with `resource_utilization_dashboard`
**Status of this doc:** implementation-ready. Section 8 contains the only open decisions.

---

## 1. Goal

Replace the spreadsheet as the system of record with a PostgreSQL database that:

1. Holds all 632 inventory items with full fidelity (nothing lost, including the formatting-encoded flags).
2. Can be updated incrementally (edit a row, add an item) without regenerating a file.
3. Exposes stable read views that `resource_utilization_dashboard` can query.
4. Tracks change over time — valuation history and usage events — which the spreadsheet cannot do.

The spreadsheet becomes a one-time import, plus an optional export path for backup.

---

## 2. Source data profile

Verified against the actual file. Use these numbers as acceptance criteria.

### Sheet 1: `Home Inventory — Valued`

> Note the **em dash** in the sheet name (`—`, U+2014). Match it exactly or select by index 0.

- 643 rows total: **632 real item rows** (rows 2–633), then a blank row and a `SUMMARY` block (rows 634–643) that must be **skipped**.
- Columns: `#`, `Item`, `Location`, `Sub-Location / Container`, `Category`, `Condition`, `Notes`, `Est. Value (CAD)`, `Value Notes`

| Column | Notes |
|---|---|
| `#` | Integer 1–633 with **one gap: #543 does not exist**. Unique. Do not assume `# == row_number`. |
| `Item` | Always present. Free text. |
| `Location` | 14 distinct values. Uses **en dash** (`–`, U+2013), e.g. `Room – Desk (top)`. Always present. |
| `Sub-Location / Container` | 24 distinct, **null in 516 of 632 rows**. Some are nested with an arrow: `Jaguar bag → plastic bag`. |
| `Category` | 183 distinct. 512 follow `Primary / Secondary` (e.g. `Electronics / Computers`); 120 are single-level (e.g. `Books`). |
| `Condition` | 77 distinct free-text values. `Good` covers 509 rows. Others include `Valid`, `Sealed`, `Fair – stick drift`, `Working – great`. **Do not force into an enum** — keep the text. |
| `Notes` | Null in 303 rows. |
| `Est. Value (CAD)` | Non-null for all 632 items. Min 0.00, max 1350.00, **sum = 10,895.35**. 470 items are > $0. |
| `Value Notes` | Null in 467 rows. One row (#54, "Mysterious earring") contains `GET APPRAISED`. |

**Formatting carries meaning — extract it, don't discard it:**

- **Green fill** (`FFE2EFDA`) on the item row = newly added item. Applies to exactly **12 items: #622–#633**. Migrate to a boolean column `is_new_addition`.
- **Yellow fill** (`FFFFF2CC`) on the value cell = item worth ≥ $100 CAD. This is *derivable* from the value — do **not** store it; compute in the view.

### Sheet 2: `Packing List`

- 243 rows: 210 items marked `Pack`, 1 marked `Maybe`, plus structural rows.
- Columns: `#`, `Item`, `Inv. #`, `Category`, `Container / Packed In`, `Status`, `Notes`
- **20 section-divider rows** where `Item` looks like `── ELECTRONICS & TECH ──` and all other columns are null. These are grouping headers — capture the section name as a column on the child rows, then drop the divider rows.
- `Inv. #` is the foreign key back to sheet 1's `#`. Mostly digit strings, but **two values are `45+` and `62+`** meaning "item #45 and additional similar items". Store the raw string *and* a parsed integer.
- Trailing block from row 233: `PACKING SUMMARY`, a legend, and a `DECISIONS STILL NEEDED:` list naming #467 and #495. Skip these rows, but surface the two undecided items as `status = 'undecided'` on their packing rows if present.
- `Container / Packed In` null in 137 rows; 10 distinct containers otherwise.

---

## 3. Target schema

Create everything in a dedicated `inventory` schema so it can live alongside the dashboard's existing tables without name collisions.

```sql
CREATE SCHEMA IF NOT EXISTS inventory;
SET search_path TO inventory, public;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ── enums ────────────────────────────────────────────────────────────
CREATE TYPE item_status AS ENUM (
  'owned', 'packed', 'stored', 'lent_out', 'sold', 'donated', 'discarded', 'lost'
);

CREATE TYPE packing_status AS ENUM ('pack', 'maybe', 'undecided', 'leave');

-- coarse grade derived from free-text condition, for filtering/charting
CREATE TYPE condition_grade AS ENUM (
  'new', 'excellent', 'good', 'fair', 'poor', 'broken', 'expired', 'unknown'
);

-- ── lookups ──────────────────────────────────────────────────────────
CREATE TABLE locations (
  id           smallserial PRIMARY KEY,
  name         citext NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE containers (
  id           smallserial PRIMARY KEY,
  name         citext NOT NULL UNIQUE,
  location_id  smallint REFERENCES locations(id),
  parent_id    smallint REFERENCES containers(id),  -- for "Jaguar bag → plastic bag"
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id           smallserial PRIMARY KEY,
  full_name    citext NOT NULL UNIQUE,   -- 'Electronics / Computers'
  primary_name citext NOT NULL,          -- 'Electronics'
  sub_name     citext                    -- 'Computers', NULL for single-level
);
CREATE INDEX ON categories (primary_name);

-- ── core ─────────────────────────────────────────────────────────────
CREATE TABLE items (
  id               bigserial PRIMARY KEY,
  legacy_ref       integer UNIQUE,        -- the spreadsheet '#'; keep forever
  name             text NOT NULL,
  quantity         integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  location_id      smallint NOT NULL REFERENCES locations(id),
  container_id     smallint REFERENCES containers(id),
  category_id      smallint REFERENCES categories(id),
  condition_text   text,
  grade            condition_grade NOT NULL DEFAULT 'unknown',
  status           item_status NOT NULL DEFAULT 'owned',
  notes            text,
  est_value_cad    numeric(10,2) CHECK (est_value_cad >= 0),
  value_notes      text,
  needs_appraisal  boolean NOT NULL DEFAULT false,
  is_new_addition  boolean NOT NULL DEFAULT false,
  acquired_on      date,
  disposed_on      date,
  search_tsv       tsvector GENERATED ALWAYS AS (
                     to_tsvector('english',
                       coalesce(name,'') || ' ' ||
                       coalesce(notes,'') || ' ' ||
                       coalesce(value_notes,''))
                   ) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON items USING gin (search_tsv);
CREATE INDEX ON items USING gin (name gin_trgm_ops);
CREATE INDEX ON items (location_id);
CREATE INDEX ON items (category_id);
CREATE INDEX ON items (est_value_cad DESC NULLS LAST);
CREATE INDEX ON items (status) WHERE status <> 'owned';

-- valuation history: the spreadsheet only held a single snapshot
CREATE TABLE item_valuations (
  id          bigserial PRIMARY KEY,
  item_id     bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  value_cad   numeric(10,2) NOT NULL CHECK (value_cad >= 0),
  valued_on   date NOT NULL DEFAULT current_date,
  method      text,      -- 'initial_import', 'resale_comp', 'appraisal', 'receipt'
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON item_valuations (item_id, valued_on DESC);

-- usage events: the input to utilization metrics
CREATE TABLE item_usage_events (
  id           bigserial PRIMARY KEY,
  item_id      bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  occurred_on  date NOT NULL DEFAULT current_date,
  event_type   text NOT NULL DEFAULT 'used',  -- 'used','maintained','lent','returned'
  duration_min integer CHECK (duration_min >= 0),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON item_usage_events (item_id, occurred_on DESC);

-- ── packing ──────────────────────────────────────────────────────────
CREATE TABLE packing_lists (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  destination  text,
  depart_on    date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE packing_list_items (
  id              bigserial PRIMARY KEY,
  list_id         integer NOT NULL REFERENCES packing_lists(id) ON DELETE CASCADE,
  item_id         bigint REFERENCES items(id) ON DELETE SET NULL,
  raw_item_name   text NOT NULL,        -- always keep, even when item_id resolves
  legacy_inv_ref  text,                 -- raw 'Inv. #' string, incl. '45+'
  section         text,                 -- e.g. 'ELECTRONICS & TECH'
  container_text  text,
  status          packing_status NOT NULL DEFAULT 'pack',
  notes           text,
  sort_order      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON packing_list_items (list_id, sort_order);
CREATE INDEX ON packing_list_items (item_id);

-- ── updated_at trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER items_touch BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER packing_items_touch BEFORE UPDATE ON packing_list_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

---

## 4. Migration script

Write `scripts/migrate_inventory.py`. Requirements:

- **Libraries:** `openpyxl` (needed for fill colours — pandas alone will not see them), `psycopg[binary]`.
- **Idempotent.** Re-running must not duplicate. Upsert on `items.legacy_ref`, `locations.name`, `containers.name`, `categories.full_name`. Wrap the whole run in a single transaction.
- **CLI:** `--xlsx PATH --dsn POSTGRES_URL [--dry-run] [--truncate]`.
- **Dry-run** prints the row counts and the sum it *would* insert, and writes no data.

### Transformation rules

1. **Row selection.** Iterate sheet rows 2–633 inclusive. Stop at the first row where `Item` is null — do not process the `SUMMARY` block.
2. **Category split.** Split `full_name` on the first ` / ` (space-slash-space). No delimiter → `primary_name = full_name`, `sub_name = NULL`. Do not split on `/` without spaces — some item *names* contain bare slashes.
3. **Container nesting.** If the sub-location contains `→`, split it; create the left side as a container and the right side as a child with `parent_id` pointing at it. Assign the item to the innermost (rightmost) container.
4. **Container → location link.** Set `containers.location_id` from the first item that references it. Where the same container name appears under two locations, leave `location_id` NULL and log a warning.
5. **`is_new_addition`.** Read `cell.fill.fgColor.rgb == 'FFE2EFDA'` on the `Item` column. Expect exactly 12 hits. If the count differs, fail loudly — the file changed.
6. **`needs_appraisal`.** True when `Value Notes` matches `/APPRAIS/i`. Expect 1 hit.
7. **`grade`.** Map `condition_text` to the enum with a case-insensitive substring table, checked in this order — first match wins:
   `broken|dead|non-functional` → `broken`; `expired|outdated` → `expired`; `poor|worn|rusted|damaged|banged` → `poor`; `fair|useable|usable|marks|blemish` → `fair`; `new|sealed|unused` → `new`; `great|excellent|very good` → `excellent`; `good|working|valid|active|current|built` → `good`; else `unknown`. Always keep the original string in `condition_text` — the grade is a convenience, not a replacement.
8. **Quantity.** Default 1. Optionally parse a trailing `(box of N)` / `(N)` / `(×N)` in the item name into `quantity`; if you do, **leave the name unchanged**.
9. **Seed valuation history.** For every item, insert one `item_valuations` row with `value_cad = est_value_cad`, `valued_on` = the file's modified date, `method = 'initial_import'`.
10. **Packing list.** Create one `packing_lists` row (name: `University Move`; leave `destination`/`depart_on` null unless the agent is told otherwise). Track the current section as you scan: a row whose `Item` matches `^──\s*(.+?)\s*──$` sets the section and is not itself inserted. `sort_order` = source row index. Resolve `item_id` by stripping non-digits from `Inv. #` and matching `items.legacy_ref`; keep the raw string in `legacy_inv_ref`. Log unresolved references rather than failing.
11. **Status mapping.** `Pack` → `pack`, `Maybe` → `maybe`, null → `pack`. Set `undecided` for the two items named in the `DECISIONS STILL NEEDED` block (#467, #495) if they appear.
12. **Whitespace.** `strip()` every string; convert empty strings to NULL. Do **not** normalise the en/em dashes in location or condition values — they are part of the data.

### Acceptance checks (script must assert these)

```sql
SELECT count(*) FROM items;                          -- 632
SELECT round(sum(est_value_cad), 2) FROM items;      -- 10895.35
SELECT count(*) FROM items WHERE est_value_cad > 0;  -- 470
SELECT count(*) FROM items WHERE is_new_addition;    -- 12
SELECT count(*) FROM locations;                      -- 14
SELECT count(*) FROM categories;                     -- 183
SELECT count(*) FROM containers;                     -- 24 (more if nesting splits some)
SELECT max(legacy_ref) FROM items;                   -- 633
SELECT count(*) FROM packing_list_items
  WHERE status = 'pack';                             -- 210
SELECT count(*) FROM packing_list_items
  WHERE item_id IS NULL;                             -- log it; 2 expected ('45+','62+')
```

---

## 5. Dashboard-facing views

The dashboard should read **views only**, never base tables. That keeps the schema free to change.

```sql
CREATE VIEW v_items AS
SELECT i.id, i.legacy_ref, i.name, i.quantity,
       l.name  AS location,
       c.name  AS container,
       cat.full_name AS category,
       cat.primary_name AS category_primary,
       i.condition_text, i.grade, i.status,
       i.est_value_cad,
       (i.est_value_cad >= 100) AS is_high_value,   -- replaces the yellow fill
       i.needs_appraisal, i.is_new_addition,
       i.notes, i.updated_at
FROM items i
JOIN locations l   ON l.id = i.location_id
LEFT JOIN containers c ON c.id = i.container_id
LEFT JOIN categories cat ON cat.id = i.category_id;

CREATE VIEW v_value_by_location AS
SELECT l.name AS location,
       count(*) AS item_count,
       sum(i.est_value_cad) AS total_value_cad,
       round(avg(i.est_value_cad), 2) AS avg_value_cad
FROM items i JOIN locations l ON l.id = i.location_id
GROUP BY l.name ORDER BY 3 DESC;

CREATE VIEW v_value_by_category AS
SELECT cat.primary_name AS category,
       count(*) AS item_count,
       sum(i.est_value_cad) AS total_value_cad
FROM items i JOIN categories cat ON cat.id = i.category_id
GROUP BY cat.primary_name ORDER BY 3 DESC;

-- the utilization join: value held vs. how much the item actually gets used
CREATE VIEW v_item_utilization AS
SELECT i.id, i.name, i.est_value_cad,
       count(u.id)                          AS use_count,
       max(u.occurred_on)                   AS last_used_on,
       current_date - max(u.occurred_on)    AS days_since_use,
       CASE WHEN count(u.id) > 0
            THEN round(i.est_value_cad / count(u.id), 2) END AS cost_per_use,
       (count(u.id) = 0 AND i.est_value_cad >= 50) AS dormant_asset
FROM items i
LEFT JOIN item_usage_events u ON u.item_id = i.id
GROUP BY i.id;

CREATE VIEW v_packing_status AS
SELECT p.section, p.status, p.container_text,
       count(*) AS item_count,
       sum(i.est_value_cad) AS packed_value_cad
FROM packing_list_items p
LEFT JOIN items i ON i.id = p.item_id
GROUP BY 1,2,3;
```

---

## 6. Ongoing updates

The point of the migration is that updates stop being file edits. Provide all three paths:

1. **Ad-hoc SQL** — a `docs/common_queries.sql` with parameterised snippets for: add item, change location, mark packed, log a usage event, record a new valuation.
2. **Helper functions** so the common cases are one call:
   ```sql
   CREATE FUNCTION add_item(p_name text, p_location text, p_category text,
                            p_value numeric DEFAULT NULL, p_notes text DEFAULT NULL)
   RETURNS bigint AS $$ ... $$ LANGUAGE plpgsql;  -- upserts lookups, returns items.id

   CREATE FUNCTION log_use(p_item_id bigint, p_when date DEFAULT current_date)
   RETURNS void AS $$ ... $$ LANGUAGE plpgsql;
   ```
   `add_item` assigns `legacy_ref = NULL` for new items — the legacy column is import provenance only, never a live sequence.
3. **Re-valuation trigger** — when `items.est_value_cad` changes, automatically append a row to `item_valuations` so history accrues without discipline.

Also add `scripts/export_inventory.py` to dump the current state back to `.xlsx` in the original column layout. It is a backup and a hand-off format, not a sync target.

---

## 7. Migrations tooling

Use whatever the dashboard already uses. If it has none, use **Alembic** (Python) or **`golang-migrate`**-style numbered SQL files. Either way:

- `migrations/0001_inventory_schema.sql` — section 3 DDL
- `migrations/0002_inventory_views.sql` — section 5 views
- `migrations/0003_inventory_functions.sql` — section 6 helpers
- Every migration has a working `down`.
- The data import is a **script**, not a migration.

---

## 8. Integration with `resource_utilization_dashboard` — read this first

I don't have the dashboard's source, so the agent must inspect the repo before writing integration code. Resolve these before starting:

**A. Database placement.** Default recommendation: **same PostgreSQL instance, same database, separate `inventory` schema.** This lets the dashboard join inventory data to its existing tables in one query. Switch to a separate database only if the dashboard's DB has a restrictive owner/role setup.

**B. Access layer.** Match the dashboard's existing pattern — do not introduce a second one. Check for SQLAlchemy models, Prisma schema, Drizzle, raw `psycopg`, etc., and extend that. If the dashboard uses an ORM, generate models for the tables in section 3 and mark the views as read-only models.

**C. What "resource utilization" means here.** The assumption baked into `item_usage_events` and `v_item_utilization` is that the dashboard tracks *how much use something gets relative to what it costs or occupies*. If the dashboard's existing concept of a "resource" has a table the inventory items should link to, add a nullable FK from `items` to it rather than duplicating. **Confirm this before building the usage-tracking UI** — if the dashboard is about something else entirely (compute, time, budget), keep the inventory tables standalone and expose only `v_value_by_location` / `v_value_by_category` as new dashboard panels.

**D. Connection config.** Reuse the dashboard's existing env var (`DATABASE_URL` or similar). Do not add a second connection string unless placement decision A says separate database.

**E. Suggested first dashboard panels.** Total value; value by location; value by category; high-value items needing appraisal; dormant assets (value ≥ $50, zero usage events); packing readiness by section.

---

## 9. Deliverables checklist

- [ ] `migrations/0001_inventory_schema.sql`, `0002_inventory_views.sql`, `0003_inventory_functions.sql` (+ downs)
- [ ] `scripts/migrate_inventory.py` with `--dry-run`, idempotent, all section-4 assertions
- [ ] `scripts/export_inventory.py`
- [ ] `docs/common_queries.sql`
- [ ] Dashboard integration per section 8, matching existing repo conventions
- [ ] `README` section: how to run the import, how to add an item, how to log a use
- [ ] Original `.xlsx` archived unmodified as the pre-migration snapshot
