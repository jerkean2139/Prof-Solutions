import { describe, it, expect } from 'vitest';
import { up, reset } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';

async function tableNames(): Promise<string[]> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
}

describe('migrations', () => {
  it('applies every migration up', async () => {
    await reset();
    await up();
    const names = await tableNames();
    for (const t of [
      'users',
      'products',
      'skus',
      'commission_plans',
      'commission_plan_lines',
      'organizations',
      'organization_agreements',
      'reps',
      'sellers',
      'customers',
      'organization_customers',
      'campaigns',
      'campaign_skus',
      'orders',
      'order_lines',
      'payments',
      'warehouses',
      'inventory_transactions',
      'inventory_lots',
      'inventory_snapshots',
      'pick_lists',
      'pick_list_lines',
      'shipments',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it('reverses cleanly to nothing but schema_migrations', async () => {
    await reset();
    const names = await tableNames();
    expect(names).toEqual(['schema_migrations']);
    // Restore the schema for the rest of the suite.
    await up();
  });

  it('is idempotent when already up to date', async () => {
    await up();
    await up(); // second run is a no-op and must not throw
    const names = await tableNames();
    expect(names).toContain('inventory_transactions');
  });
});
