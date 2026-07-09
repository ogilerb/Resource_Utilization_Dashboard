import { pool } from '../db/pool.js';
import { config } from '../config.js';

/**
 * Retention / downsampling job.
 *  1. Roll up raw compute_metrics older than RETENTION_RAW_DAYS into hourly
 *     averages (idempotent upsert into compute_metrics_hourly).
 *  2. Delete the raw rows that have been rolled up.
 *  3. Purge hourly rows older than RETENTION_HOURLY_DAYS.
 */
export async function runRetention(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Downsample raw rows past the raw window into hourly buckets.
    await client.query(
      `INSERT INTO compute_metrics_hourly
         (resource_id, bucket, cpu_percent_avg, cpu_percent_max,
          memory_bytes_avg, memory_bytes_max, sample_count)
       SELECT
         resource_id,
         date_trunc('hour', timestamp) AS bucket,
         avg(cpu_percent)::real,
         max(cpu_percent)::real,
         avg(memory_bytes)::bigint,
         max(memory_bytes)::bigint,
         count(*)::int
       FROM compute_metrics
       WHERE timestamp < now() - ($1 || ' days')::interval
       GROUP BY resource_id, bucket
       ON CONFLICT (resource_id, bucket) DO UPDATE SET
         cpu_percent_avg = EXCLUDED.cpu_percent_avg,
         cpu_percent_max = EXCLUDED.cpu_percent_max,
         memory_bytes_avg = EXCLUDED.memory_bytes_avg,
         memory_bytes_max = EXCLUDED.memory_bytes_max,
         sample_count = EXCLUDED.sample_count`,
      [config.retention.rawDays]
    );

    // 2. Drop the raw rows we just summarized.
    const del = await client.query(
      `DELETE FROM compute_metrics WHERE timestamp < now() - ($1 || ' days')::interval`,
      [config.retention.rawDays]
    );

    // 3. Purge hourly rollups past the long window.
    const purge = await client.query(
      `DELETE FROM compute_metrics_hourly WHERE bucket < now() - ($1 || ' days')::interval`,
      [config.retention.hourlyDays]
    );

    await client.query('COMMIT');
    console.log(
      `[retention] downsampled + removed ${del.rowCount} raw rows, purged ${purge.rowCount} hourly rows`
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
