#!/usr/bin/env node
// Oracle Cloud server local host-metrics agent. Same core as macOS; reads its
// own CPU%/memory via Node's `os` module (backed by /proc on Linux). Runs under
// systemd on the same host as the aggregator.
import { createAgent, loadConfig, makeOsCollector } from '../shared/agent-core.mjs';

const config = await loadConfig('/etc/telemetry-agent/config.json');
const agent = createAgent({ collect: makeOsCollector(), config });
await agent.start();
