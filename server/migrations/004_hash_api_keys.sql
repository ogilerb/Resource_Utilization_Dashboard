-- Store only a SHA-256 hash of each agent's ingest key, never the plaintext.
-- The key is shown once at creation (POST /api/resources); thereafter only its
-- hash is retained, so a database or backup leak can't reveal usable ingest
-- keys — which matters now that these rows will neighbour financial data.

-- pgcrypto provides digest() so existing plaintext keys can be hashed in place.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE resources ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

-- Backfill: hash existing plaintext keys. encode(digest(k,'sha256'),'hex') is
-- byte-identical to Node's createHash('sha256').update(k).digest('hex'), so
-- agents keep authenticating with the keys they already hold.
UPDATE resources
   SET api_key_hash = encode(digest(api_key, 'sha256'), 'hex')
 WHERE api_key IS NOT NULL AND api_key_hash IS NULL;

-- Drop the plaintext column; ingest keys are resolved by hash from now on.
ALTER TABLE resources DROP COLUMN IF EXISTS api_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_api_key_hash ON resources (api_key_hash);
