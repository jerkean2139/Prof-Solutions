import { pool, withTransaction, closePool } from '../db/pool.js';
import { rebuildSnapshots } from '../inventory/snapshot.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

// Mock-data seed for dev and test. It builds the whole money-in loop once so
// the snapshot rebuild has real ledger movement and committed demand to prove
// itself against: a team, sellers, buyers, a sale with orders and ACH payment
// references, then a finalize that commits inventory.
//
// This wipes domain data first so it is rerunnable. It refuses to run against
// production. inventory_transactions is append-only for the application, but a
// dev seed may TRUNCATE it (TRUNCATE does not fire the row-level guard).

async function wipe(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (tables) {
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
}

export async function seed(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed mock data in production.');
  }

  await wipe();

  await withTransaction(async (c) => {
    const q = async (text: string, params: unknown[] = []) =>
      (await c.query(text, params)).rows[0] as Record<string, string>;

    // --- system user (bootstrap; created_by is null) ---
    const sys = await q(
      `INSERT INTO users (email, name, role) VALUES ($1,$2,$3) RETURNING id`,
      ['system@profsol.test', 'System', 'admin'],
    );
    const by = sys.id;

    // --- commission plan: org $12 flat, distributor 12.5% ---
    const plan = await q(
      `INSERT INTO commission_plans (name, effective_from, created_by)
       VALUES ('Default 2026', '2026-01-01', $1) RETURNING id`,
      [by],
    );
    await c.query(
      `INSERT INTO commission_plan_lines (plan_id, payee_role, calc_type, value, created_by)
       VALUES ($1,'organization','flat_per_unit',12.00,$2),
              ($1,'distributor','percent_of_retail',0.1250,$2)`,
      [plan.id, by],
    );

    // --- warehouse ---
    const wh = await q(
      `INSERT INTO warehouses (name, created_by) VALUES ('Main Warehouse', $1) RETURNING id`,
      [by],
    );

    // --- products and SKUs (split by owner_entity) ---
    const detergent = await q(
      `INSERT INTO products (name, brand, category, owner_entity, created_by)
       VALUES ('Laundry Detergent','Profitable Solutions','detergent','profitable_solutions',$1) RETURNING id`,
      [by],
    );
    const candle = await q(
      `INSERT INTO products (name, brand, category, owner_entity, created_by)
       VALUES ('Route 40 Candle','Route 40','candle','legacy',$1) RETURNING id`,
      [by],
    );
    const painBeGone = await q(
      `INSERT INTO products (name, brand, category, owner_entity, created_by)
       VALUES ('Pain Be Gone','Pain Be Gone','topical','legacy',$1) RETURNING id`,
      [by],
    );

    const detSku = await q(
      `INSERT INTO skus (product_id, sku_code, description, unit_config, retail_price, product_cost, qr_code, created_by)
       VALUES ($1,'DET-5GAL','Blue, 5 gallon','5 gallon bucket',45.00,18.50,'QR-DET-5GAL',$2) RETURNING id`,
      [detergent.id, by],
    );
    const candleSku = await q(
      `INSERT INTO skus (product_id, sku_code, description, unit_config, retail_price, product_cost, qr_code, created_by)
       VALUES ($1,'CAN-3PK','Assorted 3-pack','3-pack',45.00,14.00,'QR-CAN-3PK',$2) RETURNING id`,
      [candle.id, by],
    );
    const pbgSku = await q(
      `INSERT INTO skus (product_id, sku_code, description, unit_config, retail_price, product_cost, qr_code, created_by)
       VALUES ($1,'PBG-STD','Standard unit','unit TBD',45.00,12.00,'QR-PBG-STD',$2) RETURNING id`,
      [painBeGone.id, by],
    );

    // --- organization + agreement ---
    const org = await q(
      `INSERT INTO organizations (name, org_type, status, contact_name, contact_email, ghl_contact_id, store_slug, address_line1, address_city, address_state, address_postal, created_by)
       VALUES ('Northside HS Booster Club','school','active','Dana Coach','dana@northside.test','ghl-org-northside','northside-hs','100 School Rd','Indianapolis','IN','46201',$1) RETURNING id`,
      [by],
    );
    await c.query(
      `INSERT INTO organization_agreements (organization_id, terms_version, terms_snapshot, accepted_by, created_by)
       VALUES ($1,'v1','Team keeps $12/unit. One bulk delivery on finalize. ACH only.','Dana Coach',$2)`,
      [org.id, by],
    );

    // --- rep (sources the team) ---
    const rep = await q(
      `INSERT INTO reps (ghl_contact_id, display_name, status, commission_plan_id, created_by)
       VALUES ('ghl-rep-1','Sam Rep','active',$1,$2) RETURNING id`,
      [plan.id, by],
    );

    // --- sellers (team players / parents) ---
    const seller1 = await q(
      `INSERT INTO sellers (organization_id, ghl_contact_id, display_name, seller_code, status, created_by)
       VALUES ($1,'ghl-seller-1','Jordan Parent','NS-JORDAN','active',$2) RETURNING id`,
      [org.id, by],
    );
    await q(
      `INSERT INTO sellers (organization_id, ghl_contact_id, display_name, seller_code, status, created_by)
       VALUES ($1,'ghl-seller-2','Alex Player','NS-ALEX','active',$2) RETURNING id`,
      [org.id, by],
    );

    // --- customers (end buyers, master list) ---
    const cust1 = await q(
      `INSERT INTO customers (ghl_contact_id, display_name, email, first_order_at, created_by)
       VALUES ('ghl-cust-1','Pat Buyer','pat@buyer.test', now(), $1) RETURNING id`,
      [by],
    );
    const cust2 = await q(
      `INSERT INTO customers (ghl_contact_id, display_name, email, first_order_at, created_by)
       VALUES ('ghl-cust-2','Robin Buyer','robin@buyer.test', now(), $1) RETURNING id`,
      [by],
    );
    await c.query(
      `INSERT INTO organization_customers (organization_id, customer_id, first_order_at, last_order_at, created_by)
       VALUES ($1,$2, now(), now(), $4), ($1,$3, now(), now(), $4)`,
      [org.id, cust1.id, cust2.id, by],
    );

    // --- receive inventory into the ledger (append-only) ---
    for (const [sku, qty, cost] of [
      [detSku.id, 200, 18.5],
      [candleSku.id, 150, 14.0],
      [pbgSku.id, 100, 12.0],
    ] as [string, number, number][]) {
      await c.query(
        `INSERT INTO inventory_transactions (sku_id, warehouse_id, txn_type, quantity_delta, unit_cost, reference_type, created_by)
         VALUES ($1,$2,'receipt',$3,$4,'manual',$5)`,
        [sku, wh.id, qty, cost, by],
      );
    }

    // --- sale, opened so orders can be entered (the guard requires 'open') ---
    const sale = await q(
      `INSERT INTO campaigns (organization_id, rep_id, name, commission_plan_id, starts_on, status, goal_amount, created_by)
       VALUES ($1,$2,'Northside HS Fall 2026',$3,'2026-09-01','open',5000.00,$4) RETURNING id`,
      [org.id, rep.id, plan.id, by],
    );
    await c.query(
      `INSERT INTO campaign_skus (campaign_id, sku_id, created_by)
       VALUES ($1,$2,$4),($1,$3,$4),($1,$5,$4)`,
      [sale.id, detSku.id, candleSku.id, by, pbgSku.id],
    );

    // --- orders (online + paper), each with lines and an ACH payment ref ---
    // Order 1: 2 detergent + 1 candle, credited to seller1, paid.
    const order1 = await q(
      `INSERT INTO orders (campaign_id, order_number, customer_id, seller_id, entry_channel, subtotal, created_by)
       VALUES ($1,'NS-0001',$2,$3,'online',135.00,$4) RETURNING id`,
      [sale.id, cust1.id, seller1.id, by],
    );
    await c.query(
      `INSERT INTO order_lines (order_id, sku_id, quantity, unit_price, created_by)
       VALUES ($1,$2,2,45.00,$4),($1,$3,1,45.00,$4)`,
      [order1.id, detSku.id, candleSku.id, by],
    );
    await c.query(
      `INSERT INTO payments (order_id, method, amount, status, accept_blue_ref, ghl_transaction_id, created_by)
       VALUES ($1,'ach',135.00,'authorized','ab-ref-0001','ghl-txn-0001',$2)`,
      [order1.id, by],
    );

    // Order 2: 3 Pain Be Gone, no seller (rolls up to team only), paid.
    const order2 = await q(
      `INSERT INTO orders (campaign_id, order_number, customer_id, entry_channel, subtotal, created_by)
       VALUES ($1,'NS-0002',$2,'paper',135.00,$3) RETURNING id`,
      [sale.id, cust2.id, by],
    );
    await c.query(
      `INSERT INTO order_lines (order_id, sku_id, quantity, unit_price, created_by)
       VALUES ($1,$2,3,45.00,$3)`,
      [order2.id, pbgSku.id, by],
    );
    await c.query(
      `INSERT INTO payments (order_id, method, amount, status, accept_blue_ref, ghl_transaction_id, created_by)
       VALUES ($1,'ach',135.00,'authorized','ab-ref-0002','ghl-txn-0002',$2)`,
      [order2.id, by],
    );

    // --- finalize the sale (group-triggered close). Commits inventory. ---
    await c.query(
      `UPDATE campaigns SET status='finalized', finalized_at=now(), finalized_by='Dana Coach' WHERE id=$1`,
      [sale.id],
    );
  });

  // Rebuild the derived snapshot cache from the ledger.
  const rows = await rebuildSnapshots();
  logger.info({ snapshotRows: rows.length }, 'seed complete');
}

// Run as a CLI, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      logger.error({ err: (err as Error).message }, 'seed failed');
      await closePool();
      process.exit(1);
    });
}
