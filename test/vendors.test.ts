import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { getOnHand } from '../src/domain/inventory/service.js';
import {
  createVendor,
  createPurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  receivePurchaseOrder,
} from '../src/domain/vendors/service.js';

let skuId: string;
let vendorId: string;

beforeAll(async () => {
  await ensureMigrated();
  await wipeDomain();
  await pool.query(`INSERT INTO warehouses (name) VALUES ('Main')`);
  const product = await createProduct({
    name: 'Detergent',
    brand: 'PS',
    category: 'detergent',
    ownerEntity: 'profitable_solutions',
    createdBy: null,
  });
  skuId = (await createSku({ productId: product.id, skuCode: 'DET', qrCode: 'QR', createdBy: null })).id;
  vendorId = (
    await createVendor({ name: 'Acme Supply', leadTimeDays: 14, paymentTerms: 'net30', createdBy: null })
  ).id;
});

describe('purchase orders', () => {
  let poId: string;
  let lineId: string;

  it('creates a PO and sums the subtotal in the database', async () => {
    const po = await createPurchaseOrder({
      vendorId,
      lines: [{ skuId, quantityOrdered: 100, unitCost: '18.50' }],
      createdBy: null,
    });
    expect(po.subtotal).toBe('1850.00'); // 100 * 18.50
    poId = po.id;
    const full = await getPurchaseOrder(poId);
    lineId = full.lines[0].id;
    expect(full.status).toBe('ordered');
  });

  it('receives partially, writing a ledger receipt and flagging partial', async () => {
    const po = await receivePurchaseOrder(poId, {
      receipts: [{ poLineId: lineId, quantity: 60 }],
      createdBy: null,
    });
    expect(po.status).toBe('partial');
    expect(po.lines[0].quantity_received).toBe(60);
    const snap = await getOnHand(skuId);
    expect(snap[0].quantity_on_hand).toBe(60);
    // The receipt is linked to the PO in the ledger.
    const txn = await pool.query(
      `SELECT reference_type, reference_id, unit_cost FROM inventory_transactions WHERE sku_id=$1 AND txn_type='receipt'`,
      [skuId],
    );
    expect(txn.rows[0].reference_type).toBe('purchase_order');
    expect(txn.rows[0].reference_id).toBe(poId);
    expect(txn.rows[0].unit_cost).toBe('18.50');
  });

  it('completes to received when the balance arrives', async () => {
    const po = await receivePurchaseOrder(poId, {
      receipts: [{ poLineId: lineId, quantity: 40 }],
      createdBy: null,
    });
    expect(po.status).toBe('received');
    expect(po.lines[0].quantity_received).toBe(100);
    const snap = await getOnHand(skuId);
    expect(snap[0].quantity_on_hand).toBe(100);
  });

  it('refuses to receive against a completed PO', async () => {
    await expect(
      receivePurchaseOrder(poId, { receipts: [{ poLineId: lineId, quantity: 1 }], createdBy: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('lists purchase orders with the vendor name and total', async () => {
    const list = await listPurchaseOrders();
    const mine = list.find((p: { id: string }) => p.id === poId);
    expect(mine).toBeDefined();
    expect(mine.vendor_name).toBe('Acme Supply');
    expect(mine.subtotal).toBe('1850.00');
    expect(mine.status).toBe('received');
  });
});
