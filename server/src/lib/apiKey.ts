import { createHash, randomBytes } from 'node:crypto';

/**
 * Generate a per-agent ingest key. Prefixed so it's recognizable in logs/config
 * and greppable; 32 bytes of entropy encoded url-safe.
 */
export function generateApiKey(): string {
  const raw = randomBytes(32).toString('base64url');
  return `tk_${raw}`;
}

/**
 * SHA-256 (hex) of an API key. Only the hash is stored in `resources.api_key_hash`;
 * the plaintext key is shown once at creation and never persisted, so a DB or
 * backup leak can't yield a usable ingest key. Byte-identical to Postgres
 * `encode(digest(key,'sha256'),'hex')` used by the backfill migration.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
