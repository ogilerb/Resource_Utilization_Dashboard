import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';

/**
 * Application-level encryption for the most sensitive columns — bank/Plaid
 * access tokens, account identifiers, balances. Values are encrypted in the app
 * before they hit Postgres and decrypted after they're read, so a database dump,
 * a stolen backup file, or read access to the DB yields only ciphertext.
 *
 * AES-256-GCM: authenticated, so tampering with stored ciphertext fails loudly
 * on decrypt rather than returning garbage. Each value gets a fresh random IV.
 *
 * Storage format (single opaque string, colon-delimited, versioned so the key
 * can be rotated later without a schema change):
 *   v1:<iv-b64>:<auth-tag-b64>:<ciphertext-b64>
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the standard/most-efficient size for GCM.
const VERSION = 'v1';

let cachedKey: Buffer | null = null;

/** Decode a configured key from hex (64 chars), base64, or base64url. */
function decodeKey(raw: string): Buffer {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  const b64 = t.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/**
 * Load (and cache) the 32-byte data key from DATA_ENCRYPTION_KEY or the file at
 * DATA_ENCRYPTION_KEY_FILE. Throws a clear error when a feature needs encryption
 * but no valid key is configured — encryption fails closed, never silently
 * writing plaintext.
 */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const { key, keyFile } = config.encryption;
  const material = key || (keyFile ? readFileSync(keyFile, 'utf8') : '');
  if (!material) {
    throw new Error(
      'Data encryption key not configured. Set DATA_ENCRYPTION_KEY (32 bytes as ' +
        'base64/base64url/hex) or DATA_ENCRYPTION_KEY_FILE before storing sensitive data.'
    );
  }
  const buf = decodeKey(material);
  if (buf.length !== 32) {
    throw new Error(`Data encryption key must decode to 32 bytes, got ${buf.length}.`);
  }
  cachedKey = buf;
  return buf;
}

/** True when a data key is configured (does not validate its length). */
export function encryptionConfigured(): boolean {
  return Boolean(config.encryption.key || config.encryption.keyFile);
}

/**
 * Assert encryption is usable. Call at feature startup (e.g. when the finance
 * routes mount) so a misconfigured deploy fails fast instead of at first write.
 */
export function requireEncryption(): void {
  loadKey();
}

/** Encrypt a UTF-8 string into the versioned storage format above. */
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':'
  );
}

/** Decrypt a value produced by {@link encrypt}. Throws if tampered or malformed. */
export function decrypt(payload: string): string {
  const key = loadKey();
  const parts = payload.split(':');
  if (parts.length !== 4) throw new Error('Malformed ciphertext.');
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) throw new Error(`Unsupported ciphertext version: ${version}`);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8'
  );
}
