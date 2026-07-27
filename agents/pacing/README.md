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

## Chained tasks (self-continuing missions)

A task with `"chain": true` pursues one standing **mission** across many turns. Each turn does a chunk
of real work **and writes the prompt for the next turn**, carrying a running **journal** of state
forward — so consecutive "behind pace" runs compound into ongoing progress instead of repeating.

```json
{
  "id": "money-project",
  "provider": "claude",
  "chain": true,
  "mission": "Create a project that will make me money with minimal ongoing work on my part … (buildable offline inside your working directory).",
  "seedPrompt": "Turn 1: pick ONE offline-buildable product idea and scaffold its folder + README …",
  "maxTurns": 50,
  "workspace": "{outputDir}/{id}-workspace",
  "output": "{outputDir}/{id}-turn{turn}-{datetime}.md",
  "cooldownMinutes": 120
}
```

- `mission` — the fixed goal, injected verbatim every turn. Edit it anytime; changes take effect next turn.
- `seedPrompt` — the turn-1 instruction. Each later turn's instruction is written by the previous turn.
- `maxTurns` — safety cap (default 100). The chain also stops when the model marks the mission `done`.
- `workspace` — optional; the **only** directory a turn can touch. Default `{outputDir}/{id}-workspace`.
- `output` — optional; per-turn narration artifact. Default `{outputDir}/{id}-turn{turn}-{datetime}.md`.
  Chained tasks add `{turn}` and `{workDir}` placeholders. `{outputDir}` comes from `config.json`
  (default `~/pacing-output`), so you never write a literal path — templates are fine.

**How a turn works.** The agent builds the turn's prompt from `mission` + the journal + this turn's
instruction, runs `claude` with its working directory set to `workspace`, then parses a trailing
fenced block the model must emit:

````
```pacing-next
{"done": false, "next_prompt": "…the next turn's instruction…", "journal": "…updated state summary…"}
```
````

It saves the turn's narration to `output`, appends a section to a rolling **`{id}-journal.md`**, and
records `nextPrompt` / `journal` / `turn` / `done` in `state.json` under `chains["<id>"]`. The durable
result is the **files the model builds up in the workspace**. If a turn omits the block, the agent
keeps the previous instruction and retries it next turn (never a hot-loop — cooldown and cap still bound it).

**Confinement.** On first run the agent writes `<workspace>/.claude/settings.json` that pins the turn
inside that directory with **no network**: `permissions.defaultMode: acceptEdits` (in-workspace edits
run unattended), `sandbox.autoAllowBashIfSandboxed` (bash auto-runs only when it can be OS-sandboxed;
anything reaching outside or online **fails closed**), an empty `sandbox.network` allow-list, and
`WebFetch`/`WebSearch` denied. So the mission is bounded to what's buildable offline in one folder —
code, content, plans — not deploys, signups, or API calls. It edits that file only if absent, so you
can widen the boundary by hand if you ever want to.

**Restart / stop.** Delete the task's entry under `chains` in `state.json` to start the mission over;
lower `maxTurns` or set `done: true` there to stop it.

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
