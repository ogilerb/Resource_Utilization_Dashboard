#!/usr/bin/env node
// macOS collection agent. Uses Node's `os` module for portable CPU%/memory,
// which the launchd LaunchAgent runs on an interval and restarts on wake.
import { fileURLToPath } from 'node:url';
import { createAgent, loadConfig, makeOsCollector } from '../shared/agent-core.mjs';

const config = await loadConfig(fileURLToPath(new URL('./config.json', import.meta.url)));
const agent = createAgent({ collect: makeOsCollector(), config });
await agent.start();
