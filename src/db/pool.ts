import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

// Money is NUMERIC(12,2). node-postgres returns NUMERIC as a string by
// default, which is exactly what we want: never let money touch a JS float.
// Parsing it into Number here would silently violate rule 2. Leave it.
//   (type 1700 = numeric) -- intentionally not overridden.

// Managed Postgres comes in two shapes and they need opposite SSL settings.
// A private/internal URL (postgres.railway.internal) is on a trusted network
// and speaks plaintext: asking for TLS there fails the connection outright.
// The public proxy URL requires TLS but presents a certificate Node's CA
// bundle does not know, which surfaces as "self-signed certificate in
// certificate chain" during boot.
//
// DATABASE_SSL=auto reads the URL and picks: TLS (without CA verification)
// when the URL asks for it, plaintext otherwise. Set require or disable to
// override. verify-full is there for a database with a real certificate.
export function resolveSsl(
  url: string,
  mode: 'auto' | 'require' | 'verify-full' | 'disable',
): pg.PoolConfig['ssl'] {
  if (mode === 'disable') return undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };

  let sslmode: string | null = null;
  try {
    sslmode = new URL(url).searchParams.get('sslmode');
  } catch {
    sslmode = null;
  }
  if (sslmode === null) return undefined;
  if (sslmode === 'disable') return undefined;
  if (sslmode === 'verify-full' || sslmode === 'verify-ca') {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: resolveSsl(env.DATABASE_URL, env.DATABASE_SSL),
  max: 10,
  idleTimeoutMillis: 30_000,
  // Fail a bad host or a sleeping database in ten seconds instead of hanging
  // the request (and the platform health check) indefinitely.
  connectionTimeoutMillis: 10_000,
});

// An idle client that dies -- a database restart, a network blip, a proxy
// timeout -- emits on the pool. With no listener that is an unhandled error
// event, which takes the whole process down and reads in the logs like a
// random crash. Log it; the pool replaces the client on the next checkout.
pool.on('error', (err: Error) => {
  logger.error({ err: err.message }, 'idle postgres client error');
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
