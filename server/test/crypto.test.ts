import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt, encrypt, encryptionConfigured, requireEncryption } from '../src/lib/crypto.js';

// The `test` npm script sets DATA_ENCRYPTION_KEY, so encryption is configured
// here without touching a database. No DB skip guard needed.
describe('column encryption (AES-256-GCM)', () => {
  it('reports configured and does not throw on requireEncryption', () => {
    assert.equal(encryptionConfigured(), true);
    assert.doesNotThrow(() => requireEncryption());
  });

  it('round-trips ASCII, unicode, and empty strings', () => {
    for (const value of ['access-sandbox-abc123', 'café ☕ £42.00', '', 'a'.repeat(5000)]) {
      assert.equal(decrypt(encrypt(value)), value);
    }
  });

  it('uses a fresh IV each call, so ciphertext differs but decrypts equal', () => {
    const a = encrypt('same-secret');
    const b = encrypt('same-secret');
    assert.notEqual(a, b);
    assert.equal(decrypt(a), 'same-secret');
    assert.equal(decrypt(b), 'same-secret');
  });

  it('emits the versioned four-part format', () => {
    const parts = encrypt('x').split(':');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'v1');
  });

  it('rejects tampered ciphertext (auth tag mismatch)', () => {
    const parts = encrypt('tamper-me').split(':');
    // Flip the first ciphertext character to a different base64 symbol.
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    assert.throws(() => decrypt(parts.join(':')));
  });

  it('rejects malformed and unknown-version payloads', () => {
    assert.throws(() => decrypt('not-a-ciphertext'));
    assert.throws(() => decrypt('v2:aa:bb:cc'));
  });
});
