# Pacing auto-run agent

Runs **your** tasks on the Claude subscription when you're behind your weekly pace, and stops before
you'd hit the limit or spend overage credits. Detection lives on the dashboard already; this agent is
the part that actually *uses* the subscription. Full rationale:
[`docs/claude-pacing-agent.md`](../../docs/claude-pacing-agent.md).

It runs locally (on the machine logged into your Claude subscription), reads pace from the dashboard
read API, and executes the `claude` CLI. It never pushes telemetry and never touches your API credits.

## Prerequisites

- **Node ≥ 20** (uses built-in `fetch` / `AbortSignal.timeout`; zero npm dependencies).
- **`claude` CLI logged in on your subscription**, *not* an API key — otherwise runs bill credits,
  the opposite of the point. Check that `claude` uses your Pro/Max plan before enabling.
- Your **`DASHBOARD_TOKEN`** (same secret the dashboard uses) and the dashboard's URL.
- The **claude-usage browser extension running** so pace data stays fresh; the agent no-ops on stale
  data, so it's only useful while the extension is reporting.

## Setup

```bash
cd agents/pacing
cp config.example.json config.json
cp tasks.example.json  tasks.json
# edit config.json  → dashboard.endpoint, dashboard.token, resourceName
# edit tasks.json   → the tasks you actually want (see below)
```

In `config.json`, set `providers.claude.resourceName` to match the name of the **usage** resource the
claude-usage extension pushes to (matched case-insensitively; must be unambiguous).

> **launchd PATH note:** launchd starts with a minimal `PATH`, so `claude` may not resolve by name.
> Use the absolute path in the `run` array — find it with `which claude` — e.g.
> `"run": ["/opt/homebrew/bin/claude", "-p", "{prompt}"]`.

### Try it safely first (dry run)

```bash
node pacing-agent.mjs --config config.json --dry-run
```

Logs its decision every cycle (behind / on-pace / headroom / would-run) **without executing anything**.
Temporarily lower `weeklyCapPct` / `paceMarginPct` if you want to see it decide "would run".

### Run for real

```bash
node pacing-agent.mjs --config config.json
```

### Install as a background agent (macOS launchd)

```bash
# from agents/pacing
sed -e "s#__NODE__#$(which node)#" -e "s#__AGENT_DIR__#$(pwd)#" \
  com.telemetry.pacing.plist > ~/Library/LaunchAgents/com.telemetry.pacing.plist
launchctl load ~/Library/LaunchAgents/com.telemetry.pacing.plist
# logs: tail -f pacing.log
```

`RunAtLoad` + `KeepAlive` start it at login and restart it after wake. To stop:
`launchctl unload ~/Library/LaunchAgents/com.telemetry.pacing.plist`.

## Defining tasks (`tasks.json`)

Each task:

```json
{
  "id": "reading-digest",
  "provider": "claude",
  "prompt": "…what you want Claude to do…",
  "output": "{outputDir}/reading-digest-{date}.md",
  "cooldownMinutes": 720
}
```

- `provider` — must match a key under `providers` in `config.json` (`claude`).
- `prompt` — passed to `claude -p`. Supports `{date}`, `{datetime}`, `{id}` placeholders.
- `output` — where stdout is saved. Supports `{outputDir}`, `{date}`, `{datetime}`, `{id}`. Use
  `{datetime}` if a task can run more than once a day (so runs don't overwrite each other).
- `cooldownMinutes` — minimum gap between runs of *this* task.

Make them things you'll actually read — the whole point over "burning quota" is that the output is
worth keeping. When behind pace, the agent runs the first due task and picks up the next one on the
following eligible cycle.

## How it decides (guardrails)

Every `checkIntervalSeconds`, per provider:

1. **Freshness** — ignore gauges older than `maxStaleMinutes` (default 40).
2. **Pace** — act only if `weekly utilization < weekElapsed% − paceMarginPct`.
3. **Headroom** — hold if `weekly ≥ weeklyCapPct` (85), `five_hour ≥ fiveHourCapPct` (80), or
   `extra_spend` is active. This is what keeps it out of overage credits.
4. **Cooldown** — at least `postRunCooldownMinutes` (20, ≈ one gauge refresh) between runs, so real
   usage catches up before it spends more. At most one task per cooldown.

Tune the caps in `config.json`. Lower = more conservative (leaves more headroom).

## What it does *not* do

- No fabricated/filler prompts — it only runs tasks you wrote.
- No API-key calls — it drives the subscription CLI, so it spends the plan you already pay for.
- No notifications — outputs are files; look at them whenever.
