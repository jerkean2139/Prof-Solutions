import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam } from '../src/domain/organizations/service.js';
import { createProduct, createSku, listSkus } from '../src/domain/products/service.js';
import { receiveStock, listWarehouses } from '../src/domain/inventory/service.js';
import { createSale, openSale, finalizeSale } from '../src/domain/sales/service.js';
import { createOrder } from '../src/domain/orders/service.js';
import { generatePickList, getPickListForSale, pickLine } from '../src/domain/fulfillment/service.js';

// Covers the read endpoints the PWA receiving and fulfillment screens depend on:
// the warehouse list, the product name on the SKU list, and re-reading a pick
// list from the server so the picking screen survives a reload.

let skuId: string;
let saleId: string;

async function setup() {
  await ensureMigrated();
  await wipeDomain();
  await pool.query(
    `INSERT INTO commission_plans (name, effective_from, active) VALUES ('Default','2026-01-01',true)`,
  );
  const org = await registerTeam({
    name: 'Team',
    orgType: 'school',
    ghlContactId: 'ghl-org-1',
    storeSlug: 'team',
    agreement: { termsVersion: 'v1', termsSnapshot: 't', acceptedBy: 'Coach' },
    createdBy: null,
  });
  await pool.query(`INSERT INTO warehouses (name) VALUES ('Main')`);
  const product = await createProduct({
    name: 'Detergent',
    brand: 'PS',
    category: 'detergent',
    ownerEntity: 'profitable_solutions',
    createdBy: null,
  });
  const sku = await createSku({ productId: product.id, skuCode: 'DET', qrCode: 'QR', createdBy: null });
  skuId = sku.id;
  const wh = await pool.query(`SELECT id FROM warehouses LIMIT 1`);
  await receiveStock({ skuId, warehouseId: wh.rows[0].id, quantity: 50, createdBy: null });
  const sale = await createSale({
    organizationId: org.id,
    name: 'Sale',
    skus: [{ skuId }],
    createdBy: null,
  });
  saleId = sale.id;
  await openSale(saleId);
  await createOrder({
    campaignId: saleId,
    buyer: { ghlContactId: 'b1' },
    entryChannel: 'paper',
    lines: [{ skuId, quantity: 8 }],
    createdBy: null,
  });
}

describe('fulfillment + inventory read endpoints', () => {
  beforeAll(setup);

  it('lists active warehouses', async () => {
    const rows = await listWarehouses();
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe('Main');
  });

  it('includes the product name on the SKU list (for the receiving screen)', async () => {
    const skus = await listSkus();
    const det = skus.find((s: { sku_code: string }) => s.sku_code === 'DET');
    expect(det.product_name).toBe('Detergent');
  });

  it('returns null for a sale with no pick list yet', async () => {
    expect(await getPickListForSale(saleId)).toBeNull();
  });

  it('reads back the pick list with live picked totals after generation and a pick', async () => {
    await finalizeSale(saleId, { finalizedBy: 'Coach' });
    const generated = await generatePickList(saleId, null);
    const lineId = generated.lines[0]!.id;

    // Read it back fresh, as a reload would.
    const reread = await getPickListForSale(saleId);
    expect(reread).not.toBeNull();
    expect(reread!.pick_list_number).toBe(generated.pick_list_number);
    expect(reread!.lines[0]!.quantity_required).toBe(8);
    expect(reread!.lines[0]!.quantity_picked).toBe(0);
    expect(reread!.lines[0]!.short).toBe(false); // 50 on hand covers 8

    // Pick part of it, then re-read: the picked total reflects the ledger.
    await pickLine(lineId, { quantityPicked: 3, pickedBy: null });
    const afterPick = await getPickListForSale(saleId);
    expect(afterPick!.lines[0]!.quantity_picked).toBe(3);
  });
});
