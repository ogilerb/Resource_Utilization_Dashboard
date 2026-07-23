# Claude pacing auto-run agent (v1)

**Status:** implemented — `agents/pacing/`.

## Why this exists

We pay for Claude and Google subscriptions but under-use them. The dashboard already *detects*
under-pacing — [`usage-panel.component.ts`](../dashboard/src/app/components/usage-panel.component.ts)
compares current utilization against how far we are through the 7-day window (`weekElapsedPct`) and
flags *"under-using your allowance"* — but the dashboard is **read-only**: it can see under-use, it
can't spend it.

This agent closes that gap for **Claude only** (v1). When you're behind weekly pace *and* have
session headroom, it runs a **real task you've defined** on the Claude subscription, saves the
output to a file, and stops the moment you're back on pace, your 5-hour session is spent, or you're
near the weekly cap — never tipping into overage credits, and with no notifications (the value lands
in the saved output files).

Google is deferred: the Gemini-CLI subscription path is sunsetting, and the automatable Google
surface (Antigravity, `agy`) draws from a **different** quota meter than the `gemini.google.com`
usage the dashboard scrapes today. Tracking that meter is a prerequisite — see
[`antigravity-usage-collector.md`](./antigravity-usage-collector.md).

## Why it runs locally (not on the server)

Spending the **subscription** (not pay-per-token API credits) requires the subscription-logged-in
`claude` CLI, which lives on your Mac — not the Oracle aggregator. So this is a local agent, matching
the repo's per-machine [`agents/`](../agents/) model. It only *reads* pace from the dashboard API; it
never writes telemetry.

## The control loop

Every `checkIntervalSeconds` (~10 min), for each configured provider (`claude` in v1):

1. **Read** the latest usage gauges from the dashboard read API: `GET /api/resources` to find the
   Claude `usage` resource, then `GET /api/metrics/usage?resource_id=…` for its recent samples
   ([`metrics.ts`](../server/src/routes/metrics.ts)). Authed with `DASHBOARD_TOKEN` via
   `Authorization: Bearer` ([`dashboardAuth.ts`](../server/src/middleware/dashboardAuth.ts)). Points
   come back ascending by time, so the last row per `window_kind` is the latest.
2. **Freshness guard** — if the newest gauge is older than `maxStaleMinutes` (default 40, ≈ 2× the
   claude-usage extension's 15-min poll), do nothing. Never act on stale numbers. This means your
   browser + the claude-usage extension must be running for the agent to be useful.
3. **Pace** — compute `weekElapsedPct` from `seven_day.resets_at` using the same formula as the
   dashboard, then `behind = seven_day.utilization < weekElapsedPct - paceMarginPct`.
4. **Headroom guard (no credits, no blown session)** — require all of:
   `seven_day.utilization < weeklyCapPct` (default 85), `five_hour.utilization < fiveHourCapPct`
   (default 80), and (if `stopIfExtraSpend`) the `extra_spend` gauge is **not** active (utilization
   0 / absent).
5. **Provider cooldown (overshoot guard)** — at least `postRunCooldownMinutes` (default 20, ≈ one
   gauge-refresh cycle) must have passed since this provider last ran, so real usage catches up
   before we spend more. At most one task per cooldown, never a burst.
6. If **behind AND headroom AND cooldown-elapsed AND** a task is due (per-task `cooldownMinutes`) →
   run **one** task via the provider's `run` command, capture stdout, write it to the task's
   `output` file, and record run times in the state file.
7. **Stop conditions** are emergent: once `utilization >= weekElapsedPct` it's on pace and idles for
   the week; once `five_hour` hits its cap it idles for the session. It resumes automatically the
   next window.

Providers are evaluated independently. Everything is logged each cycle (`[pacing]` prefix), and
`--dry-run` logs the decision without executing.

## Files (`agents/pacing/`)

| File | Purpose |
| --- | --- |
| `pacing-agent.mjs` | The loop above. Zero runtime deps (Node ≥20 built-ins only), same spirit as [`agents/shared/agent-core.mjs`](../agents/shared/agent-core.mjs). |
| `config.example.json` | Dashboard endpoint/token, cadence, and the `claude` provider block (caps, margin, cooldown, `run` template). Copy to `config.json`. |
| `tasks.example.json` | The tasks **you define** (`id`, `provider`, `prompt`, `output`, `cooldownMinutes`). Copy to `tasks.json` and edit. |
| `com.telemetry.pacing.plist` | launchd unit (`RunAtLoad`/`KeepAlive`), modeled on [`agents/macos/com.telemetry.agent.plist`](../agents/macos/com.telemetry.agent.plist). |
| `README.md` | Setup, guardrails, task authoring. |

No server or dashboard changes — the agent only reads existing endpoints.

## Prerequisite

The `claude` CLI must be logged in on your **subscription**, not configured with an API key —
otherwise runs bill credits, the opposite of the goal. Verify before enabling
(`claude` prints its auth/plan; a subscription login should show your Pro/Max plan, not an API-key
account).

## Verification

1. **Dry run** — `node pacing-agent.mjs --config config.json --dry-run` with loose caps; watch it
   classify behind / on-pace / headroom across cycles without executing.
2. **Forced live run** — set caps low enough that "behind + headroom" holds; confirm the task runs
   via the subscription CLI, the output file appears, the dashboard's Claude gauge ticks up on its
   next scrape, and it shows as **subscription usage, not `api_metrics` cost**.
3. **Guardrails** — confirm it stops at `weeklyCapPct`, stops the session at `fiveHourCapPct`,
   refuses when `extra_spend` is active, and no-ops on stale data.
4. **Overshoot** — confirm at most one task runs per `postRunCooldownMinutes` (no bursts).

## Later (v2, out of scope here)

Once Antigravity usage is tracked (Plan B), add an `antigravity` provider whose `run` is
`agy -p {prompt}` (OAuth/subscription auth, **not** `ANTIGRAVITY_API_KEY`), paced against the
Antigravity meter. No loop changes needed — it's another entry in `providers`.
