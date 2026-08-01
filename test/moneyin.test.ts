import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam, addSeller } from '../src/domain/organizations/service.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { receiveStock, getOnHand } from '../src/domain/inventory/service.js';
import { createSale, openSale, finalizeSale, getSale } from '../src/domain/sales/service.js';
import { createOrder, listOrders } from '../src/domain/orders/service.js';

// The whole money-in path, at the service layer: onboard a team, stock the
// warehouse, run a sale, take a paper order and an online order, finalize, and
// confirm inventory commits and the customer/seller rollups are correct.

let orgId: string;
let warehouseId: string;
let skuId: string;
let saleId: string;

async function setup() {
  await ensureMigrated();
  await wipeDomain();

  // An active commission plan for createSale to lock to.
  await pool.query(
    `INSERT INTO commission_plans (name, effective_from, active) VALUES ('Default','2026-01-01',true)`,
  );

  const org = await registerTeam({
    name: 'Northside HS',
    orgType: 'school',
    ghlContactId: 'ghl-org-1',
    storeSlug: 'northside-hs',
    agreement: { termsVersion: 'v1', termsSnapshot: 'terms', acceptedBy: 'Coach' },
    createdBy: null,
  });
  orgId = org.id;

  await addSeller({
    organizationId: orgId,
    ghlContactId: 'ghl-seller-1',
    sellerCode: 'NS-JORDAN',
    displayName: 'Jordan',
    createdBy: null,
  });

  const wh = await pool.query(`INSERT INTO warehouses (name) VALUES ('Main') RETURNING id`);
  warehouseId = wh.rows[0].id;

  const product = await createProduct({
    name: 'Detergent',
    brand: 'PS',
    category: 'detergent',
    ownerEntity: 'profitable_solutions',
    createdBy: null,
  });
  const sku = await createSku({
    productId: product.id,
    skuCode: 'DET-5GAL',
    qrCode: 'QR-DET',
    createdBy: null,
  });
  skuId = sku.id;
  await receiveStock({ skuId, warehouseId, quantity: 200, unitCost: '18.50', createdBy: null });

  const sale = await createSale({
    organizationId: orgId,
    name: 'Fall 2026',
    skus: [{ skuId }],
    createdBy: null,
  });
  saleId = sale.id;
  await openSale(saleId);
}

describe('money-in path', () => {
  beforeAll(setup);

  it('rejects an order before the sale is open elsewhere, but accepts once open', async () => {
    // Paper order with seller attribution: 2 units at 45.00 = 90.00.
    const order = await createOrder({
      campaignId: saleId,
      buyer: { ghlContactId: 'ghl-buyer-1', displayName: 'Pat' },
      sellerCode: 'NS-JORDAN',
      entryChannel: 'paper',
      lines: [{ skuId, quantity: 2 }],
      createdBy: null,
    });
    expect(order.subtotal).toBe('90.00');
    expect(order.seller_id).not.toBeNull();
  });

  it('takes an online order with an ACH payment reference and no seller', async () => {
    const order = await createOrder({
      campaignId: saleId,
      buyer: { ghlContactId: 'ghl-buyer-2', displayName: 'Robin' },
      entryChannel: 'online',
      lines: [{ skuId, quantity: 3 }],
      payment: { amount: '135.00', status: 'authorized', acceptBlueRef: 'ab-1' },
      createdBy: null,
    });
    expect(order.subtotal).toBe('135.00');
    expect(order.seller_id).toBeNull();
    expect(order.payment_id).not.toBeNull();
  });

  it('rolls buyers up to the team and the master customer list', async () => {
    const customers = await pool.query(`SELECT count(*)::int AS n FROM customers`);
    const orgCustomers = await pool.query(
      `SELECT count(*)::int AS n FROM organization_customers WHERE organization_id=$1`,
      [orgId],
    );
    expect(customers.rows[0].n).toBe(2);
    expect(orgCustomers.rows[0].n).toBe(2);
  });

  it('rejects a SKU not offered in the sale', async () => {
    const other = await createProduct({
      name: 'Candle',
      brand: 'R40',
      category: 'candle',
      ownerEntity: 'legacy',
      createdBy: null,
    });
    const otherSku = await createSku({ productId: other.id, skuCode: 'CAN', createdBy: null });
    await expect(
      createOrder({
        campaignId: saleId,
        buyer: { ghlContactId: 'ghl-buyer-3' },
        entryChannel: 'paper',
        lines: [{ skuId: otherSku.id, quantity: 1 }],
        createdBy: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('finalizes the sale and commits inventory (5 units committed, 195 available)', async () => {
    const before = await getOnHand(skuId);
    expect(before[0].quantity_committed).toBe(0); // not committed until finalize

    const result = await finalizeSale(saleId, {
      finalizedBy: 'Coach',
      nextSaleTarget: '2027-01-01',
      incentiveNote: 'Free shipping next sale',
    });
    expect(result.status).toBe('finalized');

    const after = await getOnHand(skuId);
    expect(after[0].quantity_on_hand).toBe(200);
    expect(after[0].quantity_committed).toBe(5);
    expect(after[0].quantity_available).toBe(195);
  });

  it('blocks new orders once finalized', async () => {
    await expect(
      createOrder({
        campaignId: saleId,
        buyer: { ghlContactId: 'ghl-buyer-9' },
        entryChannel: 'paper',
        lines: [{ skuId, quantity: 1 }],
        createdBy: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('lists the sale order history and reflects the finalized status', async () => {
    const orders = await listOrders(saleId);
    expect(orders.length).toBe(2);
    const sale = await getSale(saleId);
    expect(sale.status).toBe('finalized');
  });

  it('will not finalize a sale with zero orders', async () => {
    const empty = await createSale({
      organizationId: orgId,
      name: 'Empty Sale',
      skus: [{ skuId }],
      createdBy: null,
    });
    await openSale(empty.id);
    await expect(finalizeSale(empty.id, { finalizedBy: 'Coach' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
