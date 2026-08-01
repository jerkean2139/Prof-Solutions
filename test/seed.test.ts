import { describe, it, expect, beforeAll } from 'vitest';
import { seed } from '../src/seed/seed.js';
import { pool } from '../src/db/pool.js';
import { ensureMigrated } from './helpers.js';

describe('seed', () => {
  beforeAll(async () => {
    await ensureMigrated();
    await seed();
  });

  async function count(table: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(rows[0]!.n);
  }

  it('loads the full money-in loop', async () => {
    expect(await count('users')).toBe(1);
    expect(await count('products')).toBe(3);
    expect(await count('skus')).toBe(3);
    expect(await count('sellers')).toBe(2);
    expect(await count('reps')).toBe(1);
    expect(await count('customers')).toBe(2);
    expect(await count('orders')).toBe(2);
    expect(await count('order_lines')).toBe(3);
    expect(await count('payments')).toBe(2);
    expect(await count('inventory_transactions')).toBe(3);
  });

  it('finalized the sale so inventory is committed', async () => {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns LIMIT 1`,
    );
    expect(rows[0]!.status).toBe('finalized');
  });

  it('keeps both commission rates in config, not code', async () => {
    const { rows } = await pool.query<{ payee_role: string; value: string }>(
      `SELECT payee_role, value FROM commission_plan_lines ORDER BY payee_role`,
    );
    const byRole = Object.fromEntries(rows.map((r) => [r.payee_role, r.value]));
    // NUMERIC comes back as a string. Never parsed to a float.
    expect(byRole['organization']).toBe('12.0000');
    expect(byRole['distributor']).toBe('0.1250');
  });

  it('snapshots money as strings, never floats', async () => {
    const { rows } = await pool.query<{ retail_price: string }>(
      `SELECT retail_price FROM skus LIMIT 1`,
    );
    expect(typeof rows[0]!.retail_price).toBe('string');
  });
});
