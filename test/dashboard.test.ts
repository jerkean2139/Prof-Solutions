import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam } from '../src/domain/organizations/service.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { receiveStock } from '../src/domain/inventory/service.js';
import { createSale, openSale, finalizeSale } from '../src/domain/sales/service.js';
import { createOrder } from '../src/domain/orders/service.js';
import { ownerSummary } from '../src/domain/dashboard/service.js';

// The owner dashboard rollup. Reconciliation matters: revenue and margin must
// match what the underlying reports would report for the same data.

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
  const wh = await pool.query(`SELECT id FROM warehouses LIMIT 1`);
  const product = await createProduct({
    name: 'Candle',
    brand: 'PS',
    category: 'candle',
    ownerEntity: 'profitable_solutions',
    createdBy: null,
  });
  // retail 45.00, cost 15.00 -> margin 30.00 per unit.
  const sku = await createSku({
    productId: product.id,
    skuCode: 'CAN',
    retailPrice: '45.00',
    productCost: '15.00',
    createdBy: null,
  });
  await receiveStock({ skuId: sku.id, warehouseId: wh.rows[0].id, quantity: 100, createdBy: null });
  const sale = await createSale({
    organizationId: org.id,
    name: 'Sale',
    skus: [{ skuId: sku.id }],
    createdBy: null,
  });
  await openSale(sale.id);
  // Two orders, 3 + 2 = 5 units at 45.00 = 225.00 revenue; cost 5*15 = 75; margin 150.
  await createOrder({
    campaignId: sale.id,
    buyer: { ghlContactId: 'b1' },
    entryChannel: 'paper',
    lines: [{ skuId: sku.id, quantity: 3 }],
    createdBy: null,
  });
  await createOrder({
    campaignId: sale.id,
    buyer: { ghlContactId: 'b2' },
    entryChannel: 'paper',
    lines: [{ skuId: sku.id, quantity: 2 }],
    createdBy: null,
  });
}

describe('owner dashboard summary', () => {
  beforeAll(setup);

  it('rolls up revenue, margin, units, orders, and active teams', async () => {
    const d = await ownerSummary();
    expect(d.headline.revenue).toBe('225.00');
    expect(d.headline.gross_margin).toBe('150.00');
    expect(d.headline.units).toBe('5');
    expect(d.headline.order_count).toBe('2');
    expect(d.headline.active_teams).toBe('1'); // one open sale
  });

  it('counts the sales pipeline by status and reports inventory on-hand', async () => {
    const d = await ownerSummary();
    const open = d.pipeline.find((p) => p.status === 'open');
    expect(open?.sales).toBe('1');
    expect(d.inventory.on_hand_units).toBe('100');
    expect(d.inventory.negative_lines).toBe('0');
  });

  it('reflects a finalized sale as no longer open in the pipeline', async () => {
    const sale = await pool.query<{ id: string }>(`SELECT id FROM campaigns LIMIT 1`);
    await finalizeSale(sale.rows[0]!.id, { finalizedBy: 'Coach' });
    const d = await ownerSummary();
    const finalized = d.pipeline.find((p) => p.status === 'finalized');
    expect(finalized?.sales).toBe('1');
    // Revenue is unchanged by finalizing (orders still count).
    expect(d.headline.revenue).toBe('225.00');
  });
});
