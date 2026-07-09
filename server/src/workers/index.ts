import cron from 'node-cron';
import { config } from '../config.js';
import { runRetention } from './retention.js';
import { runAnthropicUsage } from './anthropic-usage.js';
import { runGeminiBilling } from './gemini-billing.js';

type Task = { name: string; schedule: string; run: () => Promise<void>; enabled: boolean };

const tasks: Task[] = [
  { name: 'retention', schedule: config.retention.cron, run: () => runRetention(), enabled: true },
  {
    name: 'anthropic-usage',
    schedule: config.anthropic.cron,
    run: () => runAnthropicUsage(),
    enabled: Boolean(config.anthropic.adminKey),
  },
  {
    name: 'gemini-billing',
    schedule: config.gemini.cron,
    run: () => runGeminiBilling(),
    enabled: Boolean(config.gemini.billingTable),
  },
];

/** Register all cron workers. Disabled tasks (missing credentials) are skipped. */
export function startWorkers(): void {
  for (const task of tasks) {
    if (!task.enabled) {
      console.log(`[workers] ${task.name} disabled (missing config)`);
      continue;
    }
    if (!cron.validate(task.schedule)) {
      console.error(`[workers] invalid cron for ${task.name}: "${task.schedule}"`);
      continue;
    }
    cron.schedule(task.schedule, () => {
      task.run().catch((err) => console.error(`[workers] ${task.name} failed`, err));
    });
    console.log(`[workers] scheduled ${task.name} (${task.schedule})`);
  }
}
