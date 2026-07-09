#!/usr/bin/env bash
# Install the macOS telemetry agent as a launchd LaunchAgent.
#
# Usage:
#   ./install.sh
# Requires: node (>=20) on PATH, and a config.json next to this script
# (copy config.example.json, fill in endpoint + apiKey from the register response).
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"
PLIST_SRC="$AGENT_DIR/com.telemetry.agent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.telemetry.agent.plist"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi
if [[ ! -f "$AGENT_DIR/config.json" ]]; then
  echo "error: $AGENT_DIR/config.json not found. Copy config.example.json and fill it in." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__AGENT_DIR__|$AGENT_DIR|g" "$PLIST_SRC" > "$PLIST_DST"

# Reload if already present.
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "Installed and loaded com.telemetry.agent"
echo "Logs: $AGENT_DIR/agent.log  /  $AGENT_DIR/agent.err.log"
echo "Stop:  launchctl unload $PLIST_DST"
