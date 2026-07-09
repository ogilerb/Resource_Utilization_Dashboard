import pg from 'pg';
import { config } from '../config.js';

// pg returns BIGINT (OID 20) and NUMERIC (OID 1700) as strings by default to
// avoid precision loss. Our values (byte counts, token counts, USD costs) fit
// safely in a JS number for dashboard use, so parse them to numbers at the
// driver level for a clean JSON API.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const { Pool } = pg;

export const pool = new Pool(
  config.db.connectionString
    ? { connectionString: config.db.connectionString, ssl: config.db.ssl }
    : {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        ssl: config.db.ssl,
      }
);

pool.on('error', (err) => {
  // Idle client errors shouldn't crash the process.
  console.error('[db] unexpected idle client error', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
