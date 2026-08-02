import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { receiveStock, adjustStock, getOnHand, listInventory } from '../src/domain/inventory/service.js';

let warehouseId: string;
let skuId: string;

describe('inventory ledger', () => {
  beforeAll(async () => {
    await ensureMigrated();
    await wipeDomain();
    const wh = await pool.query(`INSERT INTO warehouses (name) VALUES ('W') RETURNING id`);
    warehouseId = wh.rows[0].id;
    const prod = await pool.query(
      `INSERT INTO products (name, brand, category, owner_entity)
       VALUES ('P','B','detergent','profitable_solutions') RETURNING id`,
    );
    const sku = await pool.query(
      `INSERT INTO skus (product_id, sku_code, qr_code) VALUES ($1,'SKU-1','QR-1') RETURNING id`,
      [prod.rows[0].id],
    );
    skuId = sku.rows[0].id;
  });

  it('receives stock and reflects it in the snapshot', async () => {
    await receiveStock({ skuId, warehouseId, quantity: 200, unitCost: '18.50', createdBy: null });
    const snap = await getOnHand(skuId);
    expect(snap).toHaveLength(1);
    expect(snap[0].quantity_on_hand).toBe(200);
    // No committed demand, so available equals on-hand.
    expect(snap[0].quantity_available).toBe(200);
  });

  it('accumulates a second receipt', async () => {
    await receiveStock({ qrCode: 'QR-1', warehouseId, quantity: 50, createdBy: null });
    const snap = await getOnHand(skuId);
    expect(snap[0].quantity_on_hand).toBe(250);
  });

  it('applies a signed adjustment with a reason', async () => {
    await adjustStock({ skuId, warehouseId, delta: -10, reason: 'shelf count', createdBy: null });
    const snap = await getOnHand(skuId);
    expect(snap[0].quantity_on_hand).toBe(240);
  });

  it('rejects a non-positive receive quantity', async () => {
    await expect(
      receiveStock({ skuId, warehouseId, quantity: 0, createdBy: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a zero-delta adjustment', async () => {
    await expect(
      adjustStock({ skuId, warehouseId, delta: 0, reason: 'x', createdBy: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an adjustment with no reason', async () => {
    await expect(
      adjustStock({ skuId, warehouseId, delta: -1, reason: '  ', createdBy: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('404s receiving against an unknown QR code', async () => {
    await expect(
      receiveStock({ qrCode: 'QR-NOPE', warehouseId, quantity: 1, createdBy: null }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('keeps the ledger as the source of truth (snapshot matches sum of deltas)', async () => {
    const ledger = await pool.query<{ sum: string }>(
      `SELECT SUM(quantity_delta) AS sum FROM inventory_transactions WHERE sku_id=$1`,
      [skuId],
    );
    const snap = await getOnHand(skuId);
    expect(snap[0].quantity_on_hand).toBe(Number(ledger.rows[0]!.sum));
  });

  it('lists whole-catalog stock, including a SKU with no receipts as zero', async () => {
    // A brand-new SKU with no ledger activity still appears, at zero on hand.
    const prod = await pool.query(
      `SELECT product_id FROM skus WHERE id=$1`,
      [skuId],
    );
    await pool.query(
      `INSERT INTO skus (product_id, sku_code, qr_code) VALUES ($1,'SKU-2','QR-2')`,
      [prod.rows[0].product_id],
    );
    const rows = await listInventory();
    const one = rows.find((r: { sku_code: string }) => r.sku_code === 'SKU-1');
    const two = rows.find((r: { sku_code: string }) => r.sku_code === 'SKU-2');
    expect(one.on_hand).toBe(240); // 200 + 50 - 10
    expect(one.available).toBe(240);
    expect(two.on_hand).toBe(0);
    expect(two.product_name).toBeTruthy();
  });
});
