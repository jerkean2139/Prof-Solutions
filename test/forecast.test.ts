import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam } from '../src/domain/organizations/service.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { receiveStock } from '../src/domain/inventory/service.js';
import { createSale, openSale, finalizeSale } from '../src/domain/sales/service.js';
import { createOrder } from '../src/domain/orders/service.js';
import { rebuildForecasts, listForecasts, reorderList } from '../src/domain/forecast/service.js';

let skuId: string;

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
  const wh = await pool.query(`INSERT INTO warehouses (name) VALUES ('Main') RETURNING id`);
  const product = await createProduct({
    name: 'Detergent',
    brand: 'PS',
    category: 'detergent',
    ownerEntity: 'profitable_solutions',
    createdBy: null,
  });
  skuId = (await createSku({ productId: product.id, skuCode: 'DET', qrCode: 'QR', createdBy: null })).id;
  await receiveStock({ skuId, warehouseId: wh.rows[0].id, quantity: 10, createdBy: null });

  // History: a finalized sale that sold 8 units. Commits 8, leaving 2 available.
  const sale = await createSale({
    organizationId: org.id,
    name: 'Sale',
    skus: [{ skuId }],
    createdBy: null,
  });
  await openSale(sale.id);
  await createOrder({
    campaignId: sale.id,
    buyer: { ghlContactId: 'b1' },
    entryChannel: 'paper',
    lines: [{ skuId, quantity: 8 }],
    createdBy: null,
  });
  await finalizeSale(sale.id, { finalizedBy: 'Coach' });
});

describe('forecasting', () => {
  it('projects monthly demand from order history', async () => {
    const written = await rebuildForecasts();
    expect(written).toHaveLength(1);
    // One month of history, 8 units sold -> 8 projected, reorder at 8.
    expect(written[0]!.projected_units).toBe(8);
    expect(written[0]!.reorder_point).toBe(8);

    const list = await listForecasts();
    expect(list[0].sku_code).toBe('DET');
    expect(list[0].projected_units).toBe(8);
  });

  it('flags a SKU for reorder when available falls to the reorder point', async () => {
    await rebuildForecasts();
    const reorder = await reorderList();
    // Available is 10 - 8 committed = 2, at or below the reorder point of 8.
    expect(reorder).toHaveLength(1);
    expect(reorder[0].sku_code).toBe('DET');
    expect(Number(reorder[0].available)).toBe(2);
    // Suggest ordering up to two months of cover: 2*8 - 2 = 14.
    expect(Number(reorder[0].suggested_order)).toBe(14);
  });

  it('does not write to the inventory ledger', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM inventory_transactions`);
    await rebuildForecasts();
    const after = await pool.query(`SELECT count(*)::int AS n FROM inventory_transactions`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
