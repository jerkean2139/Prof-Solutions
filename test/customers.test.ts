import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam } from '../src/domain/organizations/service.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { createSale, openSale } from '../src/domain/sales/service.js';
import { createOrder } from '../src/domain/orders/service.js';
import { listMasterCustomers } from '../src/domain/customers/service.js';

// A buyer who orders through two different teams must appear once in the master
// list, credited to both teams. This is the rollup the growth loop depends on.

async function team(name: string, ghl: string, slug: string) {
  return registerTeam({
    name,
    orgType: 'school',
    ghlContactId: ghl,
    storeSlug: slug,
    agreement: { termsVersion: 'v1', termsSnapshot: 't', acceptedBy: 'Coach' },
    createdBy: null,
  });
}

describe('master client list', () => {
  let skuId: string;

  beforeAll(async () => {
    await ensureMigrated();
    await wipeDomain();
    await pool.query(
      `INSERT INTO commission_plans (name, effective_from, active) VALUES ('Default','2026-01-01',true)`,
    );
    const product = await createProduct({
      name: 'Candle',
      brand: 'PS',
      category: 'candle',
      ownerEntity: 'profitable_solutions',
      createdBy: null,
    });
    const sku = await createSku({ productId: product.id, skuCode: 'CAN', createdBy: null });
    skuId = sku.id;

    const orgA = await team('Team A', 'ghl-a', 'team-a');
    const orgB = await team('Team B', 'ghl-b', 'team-b');

    async function sale(orgId: string, name: string) {
      const s = await createSale({ organizationId: orgId, name, skus: [{ skuId }], createdBy: null });
      await openSale(s.id);
      return s.id;
    }
    const saleA = await sale(orgA.id, 'Sale A');
    const saleB = await sale(orgB.id, 'Sale B');

    // One buyer orders through both teams; another only through team A.
    await createOrder({
      campaignId: saleA,
      buyer: { ghlContactId: 'buyer-1', displayName: 'Repeat Buyer' },
      entryChannel: 'paper',
      lines: [{ skuId, quantity: 1 }],
      createdBy: null,
    });
    await createOrder({
      campaignId: saleB,
      buyer: { ghlContactId: 'buyer-1', displayName: 'Repeat Buyer' },
      entryChannel: 'paper',
      lines: [{ skuId, quantity: 1 }],
      createdBy: null,
    });
    await createOrder({
      campaignId: saleA,
      buyer: { ghlContactId: 'buyer-2', displayName: 'One Team Buyer' },
      entryChannel: 'paper',
      lines: [{ skuId, quantity: 1 }],
      createdBy: null,
    });
  });

  it('dedupes a buyer across teams and counts the teams they bought through', async () => {
    const rows = await listMasterCustomers();
    // Exactly two distinct clients, not three orders.
    expect(rows).toHaveLength(2);
    const repeat = rows.find((r: { display_name: string }) => r.display_name === 'Repeat Buyer');
    const single = rows.find((r: { display_name: string }) => r.display_name === 'One Team Buyer');
    expect(repeat.teams).toBe(2);
    expect(single.teams).toBe(1);
    expect(repeat.last_order_at).toBeTruthy();
  });
});
