import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { assertSingleReadOnlyStatement, wrapWithLimit } from './sqlGuard.js';

// Runs a validated read-only query inside a READ ONLY transaction, under the
// profsol_readonly role when configured. Even if the guard were bypassed, the
// transaction and role would reject any write. The transaction is always rolled
// back: a read makes no changes, so rollback is the clean, cheap exit.

export interface QueryResult {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

// The low-level runner, exported so the read-only guarantee can be tested
// directly (a write submitted here must be rejected by the database, not just
// by the guard). Do not expose this to untrusted SQL without the guard.
export async function runInReadOnlyTx(
  sql: string,
  opts?: { timeoutMs?: number; useRole?: boolean },
): Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }> {
  const timeoutMs = opts?.timeoutMs ?? env.AGENT_QUERY_TIMEOUT_MS;
  const useRole = opts?.useRole ?? env.AGENT_USE_READONLY_ROLE;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    // timeoutMs is a validated positive integer from env or a caller, never user text.
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    if (useRole) await client.query('SET LOCAL ROLE profsol_readonly');
    const result = await client.query(sql);
    return { rows: result.rows, fields: result.fields.map((f) => ({ name: f.name })) };
  } finally {
    // Always end the transaction without committing; a read changes nothing.
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection may already be aborted; releasing is enough */
    }
    client.release();
  }
}

export async function runReadOnlyQuery(
  sql: string,
  opts?: { maxRows?: number; timeoutMs?: number; useRole?: boolean },
): Promise<QueryResult> {
  const maxRows = opts?.maxRows ?? env.AGENT_QUERY_MAX_ROWS;
  assertSingleReadOnlyStatement(sql);
  const wrapped = wrapWithLimit(sql, maxRows);
  const { rows, fields } = await runInReadOnlyTx(wrapped, {
    timeoutMs: opts?.timeoutMs,
    useRole: opts?.useRole,
  });
  const truncated = rows.length > maxRows;
  const kept = truncated ? rows.slice(0, maxRows) : rows;
  return {
    sql: wrapped,
    columns: fields.map((f) => f.name),
    rows: kept,
    rowCount: kept.length,
    truncated,
  };
}
