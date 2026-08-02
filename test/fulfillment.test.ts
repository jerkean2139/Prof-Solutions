import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam } from '../src/domain/organizations/service.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { receiveStock, getOnHand } from '../src/domain/inventory/service.js';
import { createSale, openSale, finalizeSale, getSale } from '../src/domain/sales/service.js';
import { createOrder } from '../src/domain/orders/service.js';
import {
  generatePickList,
  pickLine,
  completePickList,
  createShipment,
  getPackingSlip,
} from '../src/domain/fulfillment/service.js';

let skuId: string;
let saleId: string;
let pickListId: string;
let lineId: string;

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
  await receiveStock({ skuId, warehouseId: wh.rows[0].id, quantity: 200, createdBy: null });
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
    lines: [{ skuId, quantity: 5 }],
    createdBy: null,
  });
  await finalizeSale(saleId, { finalizedBy: 'Coach' });
}

describe('fulfillment', () => {
  beforeAll(setup);

  it('generates a bulk pick list from a finalized sale and moves it to picking', async () => {
    const pl = await generatePickList(saleId, null);
    pickListId = pl.pick_list_id;
    expect(pl.lines).toHaveLength(1);
    expect(pl.lines[0]!.quantity_required).toBe(5);
    expect(pl.lines[0]!.short).toBe(false); // 195 available covers 5
    lineId = pl.lines[0]!.id;
    const sale = await getSale(saleId);
    expect(sale.status).toBe('picking');
  });

  it('will not generate a pick list from a non-finalized sale', async () => {
    await expect(generatePickList(saleId, null)).rejects.toMatchObject({ status: 409 });
  });

  it('decrements the ledger only when a pick line is completed', async () => {
    const before = await getOnHand(skuId);
    expect(before[0].quantity_on_hand).toBe(200);

    await pickLine(lineId, { quantityPicked: 5, pickedBy: null });

    const after = await getOnHand(skuId);
    expect(after[0].quantity_on_hand).toBe(195); // 200 - 5 pick
    // Ledger now has a receipt and a pick.
    const ledger = await pool.query<{ txn_type: string; quantity_delta: number }>(
      `SELECT txn_type, quantity_delta FROM inventory_transactions WHERE sku_id=$1 ORDER BY created_at`,
      [skuId],
    );
    expect(ledger.rows.map((r) => `${r.txn_type}:${r.quantity_delta}`)).toEqual([
      'receipt:200',
      'pick:-5',
    ]);
  });

  it('ships one bulk delivery, releases the commitment, and produces a packing slip', async () => {
    await completePickList(pickListId);
    const shipment = await createShipment(pickListId, {
      carrier: 'UPS',
      trackingNumber: '1Z999',
      createdBy: null,
    });
    expect(shipment.packing_slip_number).toMatch(/^PS-/);

    const sale = await getSale(saleId);
    expect(sale.status).toBe('delivered');

    // Delivered sale leaves the committed set; on-hand reflects the picks.
    const snap = await getOnHand(skuId);
    expect(snap[0].quantity_on_hand).toBe(195);
    expect(snap[0].quantity_committed).toBe(0);
    expect(snap[0].quantity_available).toBe(195);

    const slip = await getPackingSlip(pickListId);
    expect(slip.organization_name).toBe('Team');
    expect(slip.lines[0].quantity_picked).toBe(5);
    expect(slip.shipment.tracking_number).toBe('1Z999');
  });

  it('will not ship from a sale that is not picking', async () => {
    await expect(
      createShipment(pickListId, { createdBy: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('flags a short pick list when demand exceeds available', async () => {
    // A second team orders more than the remaining 195.
    const org2 = await registerTeam({
      name: 'Team2',
      orgType: 'school',
      ghlContactId: 'ghl-org-2',
      storeSlug: 'team2',
      agreement: { termsVersion: 'v1', termsSnapshot: 't', acceptedBy: 'Coach2' },
      createdBy: null,
    });
    const sale2 = await createSale({
      organizationId: org2.id,
      name: 'Sale2',
      skus: [{ skuId }],
      createdBy: null,
    });
    await openSale(sale2.id);
    await createOrder({
      campaignId: sale2.id,
      buyer: { ghlContactId: 'b2' },
      entryChannel: 'paper',
      lines: [{ skuId, quantity: 300 }],
      createdBy: null,
    });
    await finalizeSale(sale2.id, { finalizedBy: 'Coach2' });
    const pl = await generatePickList(sale2.id, null);
    expect(pl.short).toBe(true);
    expect(pl.lines[0]!.shortage).toBe(105); // 300 required - 195 available
  });
});
