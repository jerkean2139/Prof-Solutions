import { pool } from '../src/db/pool.js';
import { up } from '../src/db/migrate.js';

export async function ensureMigrated(): Promise<void> {
  await up();
}

// Truncate all domain data but leave the schema in place.
export async function wipeDomain(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (tables) {
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
}

// A minimal fixture: one of everything needed to exercise the guards.
export async function minimalFixture() {
  const q = async (text: string, params: unknown[] = []) =>
    (await pool.query(text, params)).rows[0] as Record<string, string>;

  const sys = await q(
    `INSERT INTO users (email, name, role) VALUES ('t@t.test','T','admin') RETURNING id`,
  );
  const wh = await q(`INSERT INTO warehouses (name) VALUES ('W') RETURNING id`);
  const plan = await q(
    `INSERT INTO commission_plans (name, effective_from) VALUES ('P','2026-01-01') RETURNING id`,
  );
  const prod = await q(
    `INSERT INTO products (name, brand, category, owner_entity)
     VALUES ('P','B','detergent','profitable_solutions') RETURNING id`,
  );
  const sku = await q(
    `INSERT INTO skus (product_id, sku_code, qr_code) VALUES ($1,'SKU-1','QR-1') RETURNING id`,
    [prod.id],
  );
  const org = await q(
    `INSERT INTO organizations (name, org_type) VALUES ('O','school') RETURNING id`,
  );
  const cust = await q(
    `INSERT INTO customers (ghl_contact_id) VALUES ('ghl-c-1') RETURNING id`,
  );

  return {
    userId: sys.id,
    warehouseId: wh.id,
    planId: plan.id,
    productId: prod.id,
    skuId: sku.id,
    orgId: org.id,
    customerId: cust.id,
  };
}
