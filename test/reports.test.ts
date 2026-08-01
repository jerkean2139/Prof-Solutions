import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam, addSeller, listOrgCustomers } from '../src/domain/organizations/service.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { receiveStock } from '../src/domain/inventory/service.js';
import { createSale, openSale, finalizeSale } from '../src/domain/sales/service.js';
import { createOrder } from '../src/domain/orders/service.js';
import { marginReport, sellerLeaderboard } from '../src/domain/reports/service.js';

let orgId: string;
let detergentSku: string;
let candleSku: string;

beforeAll(async () => {
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
  orgId = org.id;
  await addSeller({ organizationId: orgId, ghlContactId: 'ghl-s1', sellerCode: 'S1', createdBy: null });
  await addSeller({ organizationId: orgId, ghlContactId: 'ghl-s2', sellerCode: 'S2', createdBy: null });
  const wh = await pool.query(`INSERT INTO warehouses (name) VALUES ('Main') RETURNING id`);
  const warehouseId = wh.rows[0].id;

  // Two products in different legal entities.
  const det = await createProduct({
    name: 'Detergent',
    brand: 'PS',
    category: 'detergent',
    ownerEntity: 'profitable_solutions',
    createdBy: null,
  });
  const can = await createProduct({
    name: 'Candle',
    brand: 'Route 40',
    category: 'candle',
    ownerEntity: 'legacy',
    createdBy: null,
  });
  detergentSku = (await createSku({ productId: det.id, skuCode: 'DET', qrCode: 'QD', productCost: '18.50', createdBy: null })).id;
  candleSku = (await createSku({ productId: can.id, skuCode: 'CAN', qrCode: 'QC', productCost: '14.00', createdBy: null })).id;
  await receiveStock({ skuId: detergentSku, warehouseId, quantity: 500, createdBy: null });
  await receiveStock({ skuId: candleSku, warehouseId, quantity: 500, createdBy: null });

  // One sale offering both SKUs. Seller S1 sells detergent, S2 sells candles.
  const sale = await createSale({
    organizationId: orgId,
    name: 'Fall',
    skus: [{ skuId: detergentSku }, { skuId: candleSku }],
    createdBy: null,
  });
  await openSale(sale.id);
  await createOrder({
    campaignId: sale.id,
    buyer: { ghlContactId: 'buyer-1', displayName: 'Pat' },
    sellerCode: 'S1',
    entryChannel: 'paper',
    lines: [{ skuId: detergentSku, quantity: 4 }], // 180.00 detergent
    createdBy: null,
  });
  await createOrder({
    campaignId: sale.id,
    buyer: { ghlContactId: 'buyer-2', displayName: 'Robin' },
    sellerCode: 'S2',
    entryChannel: 'paper',
    lines: [{ skuId: candleSku, quantity: 2 }], // 90.00 candle
    createdBy: null,
  });
  await finalizeSale(sale.id, { finalizedBy: 'Coach' });
});

describe('margin report', () => {
  it('splits revenue and margin by owner_entity and channel', async () => {
    const rows = await marginReport({});
    const byEntity = Object.fromEntries(rows.map((r) => [r.owner_entity, r]));

    // Profitable Solutions: 4 detergent, 180.00 revenue, cost 74.00, margin 106.00
    expect(byEntity['profitable_solutions']).toMatchObject({
      channel: 'fundraising',
      units: '4',
      revenue: '180.00',
      product_cost: '74.00',
      gross_margin: '106.00',
    });
    // Legacy: 2 candle, 90.00 revenue, cost 28.00, margin 62.00
    expect(byEntity['legacy']).toMatchObject({
      units: '2',
      revenue: '90.00',
      product_cost: '28.00',
      gross_margin: '62.00',
    });
  });

  it('filters by owner_entity', async () => {
    const rows = await marginReport({ ownerEntity: 'legacy' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner_entity).toBe('legacy');
  });
});

describe('seller leaderboard', () => {
  it('ranks sellers by revenue within the org', async () => {
    const rows = await sellerLeaderboard({ organizationId: orgId });
    const byCode = Object.fromEntries(rows.map((r) => [r.seller_code, r]));
    expect(byCode['S1']).toMatchObject({ units: '4', revenue: '180.00' });
    expect(byCode['S2']).toMatchObject({ units: '2', revenue: '90.00' });
    // Highest revenue first.
    expect(rows[0]!.seller_code).toBe('S1');
  });
});

describe('org customer base', () => {
  it('lists the buyers who ordered through the team', async () => {
    const customers = await listOrgCustomers(orgId);
    expect(customers).toHaveLength(2);
    const names = customers.map((c: { display_name: string }) => c.display_name).sort();
    expect(names).toEqual(['Pat', 'Robin']);
  });
});
