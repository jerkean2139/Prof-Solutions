import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { receiveStock, getOnHand } from '../src/domain/inventory/service.js';
import { registerTeam } from '../src/domain/organizations/service.js';
import { createSale, openSale, finalizeSale } from '../src/domain/sales/service.js';
import { createOrder } from '../src/domain/orders/service.js';
import {
  generatePickList,
  pickLine,
  completePickList,
  createShipment,
} from '../src/domain/fulfillment/service.js';

// Guards on completing a pick list. Completing is the gate to shipping: it
// flips the sale to delivered and pushes tracking to GHL. Since pickLine is
// the only path that writes the ledger, completing an unpicked list would
// tell the team their delivery is on the way while the stock never moved.

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
    ghlContactId: 'ghl-org-c1',
    storeSlug: 'team-complete',
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
  const sku = await createSku({
    productId: product.id,
    skuCode: 'DET-C',
    qrCode: 'QR-C',
    createdBy: null,
  });
  skuId = sku.id;
  const wh = await pool.query(`SELECT id FROM warehouses LIMIT 1`);
  await receiveStock({ skuId, warehouseId: wh.rows[0].id, quantity: 100, createdBy: null });
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
    buyer: { ghlContactId: 'b-c1' },
    entryChannel: 'paper',
    lines: [{ skuId, quantity: 10 }],
    createdBy: null,
  });
  await finalizeSale(saleId, { finalizedBy: 'Coach' });
  const pl = await generatePickList(saleId, null);
  pickListId = pl.pick_list_id;
  lineId = pl.lines[0]!.id;
}

describe('completing a pick list', () => {
  beforeAll(setup);

  it('refuses to complete when nothing has been picked', async () => {
    await expect(completePickList(pickListId)).rejects.toMatchObject({ status: 409 });

    // Nothing moved: no pick transaction, on-hand untouched.
    const ledger = await pool.query(
      `SELECT count(*)::int AS n FROM inventory_transactions
        WHERE sku_id=$1 AND txn_type='pick'`,
      [skuId],
    );
    expect(ledger.rows[0].n).toBe(0);
    const onHand = await getOnHand(skuId);
    expect(onHand[0].quantity_on_hand).toBe(100);
  });

  it('refuses to ship a pick list that was never completed', async () => {
    await expect(
      createShipment(pickListId, { carrier: 'UPS', trackingNumber: '1Z-NOPE', createdBy: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a partial pick unless the short ship is explicit', async () => {
    await pickLine(lineId, { quantityPicked: 4, pickedBy: null });
    await expect(completePickList(pickListId)).rejects.toMatchObject({ status: 409 });
  });

  it('completes a partial pick when the short ship is explicit', async () => {
    const done = await completePickList(pickListId, { allowShort: true });
    expect(done.status).toBe('complete');
  });

  it('completes normally once every line is fully picked', async () => {
    await wipeDomain();
    await setup();
    await pickLine(lineId, { quantityPicked: 10, pickedBy: null });

    const done = await completePickList(pickListId);
    expect(done.status).toBe('complete');

    const onHand = await getOnHand(skuId);
    expect(onHand[0].quantity_on_hand).toBe(90); // 100 - 10 picked
  });
});
