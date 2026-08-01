import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain, minimalFixture } from './helpers.js';

let fx: Awaited<ReturnType<typeof minimalFixture>>;

beforeAll(async () => {
  await ensureMigrated();
  await wipeDomain();
  fx = await minimalFixture();
});

async function insertReceipt(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO inventory_transactions (sku_id, warehouse_id, txn_type, quantity_delta, created_by)
     VALUES ($1,$2,'receipt',10,$3) RETURNING id`,
    [fx.skuId, fx.warehouseId, fx.userId],
  );
  return rows[0]!.id;
}

describe('inventory_transactions is append-only', () => {
  it('rejects UPDATE', async () => {
    const id = await insertReceipt();
    await expect(
      pool.query(`UPDATE inventory_transactions SET quantity_delta=1 WHERE id=$1`, [id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects DELETE', async () => {
    const id = await insertReceipt();
    await expect(
      pool.query(`DELETE FROM inventory_transactions WHERE id=$1`, [id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects a zero quantity_delta', async () => {
    await expect(
      pool.query(
        `INSERT INTO inventory_transactions (sku_id, warehouse_id, txn_type, quantity_delta, created_by)
         VALUES ($1,$2,'receipt',0,$3)`,
        [fx.skuId, fx.warehouseId, fx.userId],
      ),
    ).rejects.toThrow();
  });

  it('requires a reason on adjustments', async () => {
    await expect(
      pool.query(
        `INSERT INTO inventory_transactions (sku_id, warehouse_id, txn_type, quantity_delta, created_by)
         VALUES ($1,$2,'adjustment',-3,$3)`,
        [fx.skuId, fx.warehouseId, fx.userId],
      ),
    ).rejects.toThrow();
    // Same insert with a reason succeeds.
    await expect(
      pool.query(
        `INSERT INTO inventory_transactions (sku_id, warehouse_id, txn_type, quantity_delta, reason, created_by)
         VALUES ($1,$2,'adjustment',-3,'shelf count',$3)`,
        [fx.skuId, fx.warehouseId, fx.userId],
      ),
    ).resolves.toBeDefined();
  });
});

describe('orders are gated on an open sale', () => {
  async function makeCampaign(status: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, commission_plan_id, status)
       VALUES ($1,'C',$2,$3) RETURNING id`,
      [fx.orgId, fx.planId, status],
    );
    return rows[0]!.id;
  }

  it('rejects an order when the sale is draft', async () => {
    const c = await makeCampaign('draft');
    await expect(
      pool.query(
        `INSERT INTO orders (campaign_id, order_number, customer_id, entry_channel)
         VALUES ($1,'O-DRAFT',$2,'paper')`,
        [c, fx.customerId],
      ),
    ).rejects.toThrow(/open/i);
  });

  it('accepts an order when the sale is open, then blocks edits after finalize', async () => {
    const c = await makeCampaign('open');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (campaign_id, order_number, customer_id, entry_channel)
       VALUES ($1,'O-OPEN',$2,'paper') RETURNING id`,
      [c, fx.customerId],
    );
    const orderId = rows[0]!.id;
    expect(orderId).toBeTruthy();

    // Finalize the sale, then an edit to the order must be blocked.
    await pool.query(`UPDATE campaigns SET status='finalized' WHERE id=$1`, [c]);
    await expect(
      pool.query(`UPDATE orders SET notes='late edit' WHERE id=$1`, [orderId]),
    ).rejects.toThrow(/open/i);
  });
});
