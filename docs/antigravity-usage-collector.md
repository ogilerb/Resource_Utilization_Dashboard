# Antigravity usage collector (Plan B — not yet built)

**Status:** planned. Build this before any Google auto-run.

## Why this exists

The obvious "just use Gemini" plan hit a real wall worth recording:

- The **Gemini CLI subscription path is sunsetting** (June 18 2026 for non-Enterprise), so we can't
  shell out to a subscription-authed `gemini` CLI the way we do with `claude`.
- The automatable Google surface that *is* subscription-authed is **Antigravity** (`agy` CLI, OAuth
  login on Google AI Pro/Ultra).
- **But Antigravity's quota is a separate meter** from the `gemini.google.com` chat usage that the
  [`gemini-usage`](../extensions/gemini-usage/) extension scrapes today. Antigravity has its own
  usage limits (refresh ~every 5 hours) that Google has adjusted independently.

So "spend the Google subscription via Antigravity when behind pace" only closes the loop if we pace
against **Antigravity's own meter** — which the dashboard does not track yet. This plan adds that
tracking. It is *tracking only* (mirrors the existing usage collectors); spending comes later.

## Goal

Get Antigravity's own quota onto the dashboard as a new `usage`-type resource named **`Antigravity`**,
so the existing usage panel shows its gauges and pacing automatically — the prerequisite signal for a
future Google auto-run.

## Step 1 — Spike: how do we read Antigravity quota locally?

This is the open question; resolve it first. Leads, in preference order:

1. **`agy` CLI usage/quota subcommand.** Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`.
   Then inspect `agy --help` for a usage/quota/status command. This is the cleanest source if it
   exists (no browser, subscription-authed via the same keyring login).
2. **Third-party reference `github.com/skainguyen1412/antigravity-usage`** — a CLI that already
   reports Antigravity quota. Read *how* it sources the numbers (local state file? OS keyring? an
   internal HTTP endpoint hit with the OAuth session?) and reuse the method.
3. **Antigravity local state/config files** written by the desktop app / CLI on login.
4. **A usage web page on `antigravity.google`** readable with the logged-in session — fallback via a
   browser-extension route, exactly as `gemini-usage` renders `gemini.google.com/usage`.

Document the chosen source here once the spike lands; it decides the collector's shape (local Node
script vs. browser extension).

## Step 2 — Collector

Model on [`agents/shared/agent-core.mjs`](../agents/shared/agent-core.mjs) (local Node script) if the
source is a CLI/file, or on [`extensions/gemini-usage/`](../extensions/gemini-usage/) if the only
source is the web page. On a timer it:

- reads current Antigravity utilization %,
- maps it to `window_kind`s — at least `five_hour` (the 5-hour refresh window), plus any `seven_day`
  / model-scoped windows the source exposes,
- `POST`s `{ samples: [...] }` to `/api/ingest/usage`
  ([`ingest.ts`](../server/src/routes/ingest.ts)) under the `Antigravity` resource, using an ingest
  key minted by registering the resource (`POST /api/resources` with `type: "usage"`,
  [`resources.ts`](../server/src/routes/resources.ts)).

Reuse the sample shape from the existing collectors — `{ window, utilization, resets_at, raw }` — and
follow the **"never write a fake 0"** rule: omit a gauge that fails to parse rather than reporting 0
(a false zero looks like a real usage drop).

**No schema or dashboard changes** — this reuses the `usage` resource type and the `usage_metrics`
table ([`002_usage.sql`](../server/migrations/002_usage.sql)); Antigravity shows up as another gauge
with pacing in the existing panel.

## Verification

Register the `Antigravity` resource, run the collector, use Antigravity for a bit, and confirm its
gauge appears and moves on the dashboard — with correct reset/freshness parsing and no phantom zeros.

## Then (v2)

With the meter tracked, extend the Claude pacing agent
([`claude-pacing-agent.md`](./claude-pacing-agent.md)) with an `antigravity` provider:
`run` = `agy -p {prompt}` (or `antigravity run --prompt-file … --yes --output json </dev/null`),
OAuth/subscription auth (**not** `ANTIGRAVITY_API_KEY`), paced against this Antigravity meter. The
control loop is provider-agnostic, so this is config, not new logic.
