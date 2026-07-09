import { randomBytes } from 'node:crypto';

/**
 * Generate a per-agent ingest key. Prefixed so it's recognizable in logs/config
 * and greppable; 32 bytes of entropy encoded url-safe.
 */
export function generateApiKey(): string {
  const raw = randomBytes(32).toString('base64url');
  return `tk_${raw}`;
}
