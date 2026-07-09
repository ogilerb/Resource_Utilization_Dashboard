#!/usr/bin/env bash
# Install the Oracle-server host-metrics agent under systemd.
# Run as root (or with sudo). Expects the repo checked out at a stable path.
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="/etc/telemetry-agent"
UNIT_DST="/etc/systemd/system/telemetry-agent.service"

if [[ $EUID -ne 0 ]]; then
  echo "error: run as root (sudo)" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR"
if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
  cp "$AGENT_DIR/config.example.json" "$CONFIG_DIR/config.json"
  echo "Wrote $CONFIG_DIR/config.json — edit it to set endpoint + apiKey."
fi

# Point the unit's ExecStart at the actual agent location.
sed "s|/opt/telemetry/agents/oracle/agent.mjs|$AGENT_DIR/agent.mjs|" \
  "$AGENT_DIR/telemetry-agent.service" > "$UNIT_DST"

systemctl daemon-reload
systemctl enable telemetry-agent
systemctl restart telemetry-agent
echo "telemetry-agent installed. Status: systemctl status telemetry-agent"
