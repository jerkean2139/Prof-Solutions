import pg from 'pg';
import { env } from '../config/env.js';

// Money is NUMERIC(12,2). node-postgres returns NUMERIC as a string by
// default, which is exactly what we want: never let money touch a JS float.
// Parsing it into Number here would silently violate rule 2. Leave it.
//   (type 1700 = numeric) -- intentionally not overridden.

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
