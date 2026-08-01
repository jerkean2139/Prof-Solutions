import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam, addSeller } from '../src/domain/organizations/service.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { receiveStock } from '../src/domain/inventory/service.js';
import { createSale, openSale, finalizeSale } from '../src/domain/sales/service.js';
import { createOrder } from '../src/domain/orders/service.js';
import {
  generatePickList,
  pickLine,
  completePickList,
  createShipment,
} from '../src/domain/fulfillment/service.js';
import { settleSale, getSettlement } from '../src/domain/settlement/service.js';

let orgId: string;
let repId: string;
let skuId: string;
let warehouseId: string;

// Run a sale from open through delivery so it can be settled. Returns the sale id.
async function runSaleToDelivered(opts: {
  planId?: string;
  quantity: number;
  sellerCode?: string;
}): Promise<string> {
  const sale = await createSale({
    organizationId: orgId,
    name: 'Sale',
    repId,
    commissionPlanId: opts.planId,
    skus: [{ skuId }],
    createdBy: null,
  });
  await openSale(sale.id);
  await createOrder({
    campaignId: sale.id,
    buyer: { ghlContactId: `b-${sale.id}` },
    sellerCode: opts.sellerCode,
    entryChannel: 'paper',
    lines: [{ skuId, quantity: opts.quantity }],
    createdBy: null,
  });
  await finalizeSale(sale.id, { finalizedBy: 'Coach' });
  const pl = await generatePickList(sale.id, null);
  await pickLine(pl.lines[0]!.id, { quantityPicked: opts.quantity, pickedBy: null });
  await completePickList(pl.pick_list_id);
  await createShipment(pl.pick_list_id, { trackingNumber: 'T', createdBy: null });
  return sale.id;
}

beforeAll(async () => {
  await ensureMigrated();
  await wipeDomain();
  // Default plan: org $12 flat per unit, distributor 12.5% of retail.
  const plan = await pool.query(
    `INSERT INTO commission_plans (name, effective_from, active) VALUES ('Default','2026-01-01',true) RETURNING id`,
  );
  await pool.query(
    `INSERT INTO commission_plan_lines (plan_id, payee_role, calc_type, value)
     VALUES ($1,'organization','flat_per_unit',12.00),($1,'distributor','percent_of_retail',0.1250)`,
    [plan.rows[0].id],
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
  const rep = await pool.query(
    `INSERT INTO reps (ghl_contact_id, display_name, status) VALUES ('ghl-rep-1','Sam','active') RETURNING id`,
  );
  repId = rep.rows[0].id;
  await addSeller({
    organizationId: orgId,
    ghlContactId: 'ghl-seller-1',
    sellerCode: 'NS-JORDAN',
    createdBy: null,
  });
  const product = await createProduct({
    name: 'Detergent',
    brand: 'PS',
    category: 'detergent',
    ownerEntity: 'profitable_solutions',
    createdBy: null,
  });
  const sku = await createSku({
    productId: product.id,
    skuCode: 'DET',
    qrCode: 'QR',
    productCost: '18.50',
    createdBy: null,
  });
  skuId = sku.id;
  const wh = await pool.query(`INSERT INTO warehouses (name) VALUES ('Main') RETURNING id`);
  warehouseId = wh.rows[0].id;
  await receiveStock({ skuId, warehouseId, quantity: 500, createdBy: null });
});

describe('settlement', () => {
  it('computes payouts from the locked plan and reconciles to the penny', async () => {
    // 4 units at 45.00 = 180.00 revenue. Clean numbers, no rounding drift.
    const saleId = await runSaleToDelivered({ quantity: 4, sellerCode: 'NS-JORDAN' });
    const s = await settleSale(saleId, null);

    expect(s.gross_revenue).toBe('180.00');
    expect(s.organization_payout).toBe('48.00'); // 12.00 * 4
    expect(s.distributor_commission).toBe('22.50'); // 0.1250 * 180.00
    expect(s.seller_commission).toBe('0.00'); // no seller line in the plan
    expect(s.product_cost_total).toBe('74.00'); // 18.50 * 4
    expect(s.gross_profit).toBe('35.50'); // 180 - 48 - 22.50 - 0 - 74

    // Reconciliation: profit equals revenue minus every payout and cost.
    const parts =
      Number(s.organization_payout) +
      Number(s.distributor_commission) +
      Number(s.seller_commission) +
      Number(s.product_cost_total) +
      Number(s.gross_profit);
    expect(parts).toBeCloseTo(Number(s.gross_revenue), 2);
  });

  it('accrues the distributor commission to the rep in the ledger', async () => {
    const saleId = await runSaleToDelivered({ quantity: 4, sellerCode: 'NS-JORDAN' });
    await settleSale(saleId, null);
    const view = await getSettlement(saleId);
    const rep = view.commissions.find((c: { payee_type: string }) => c.payee_type === 'rep');
    expect(rep).toBeDefined();
    expect(rep.amount).toBe('22.50');
    // No seller line in the plan, so no seller accrual.
    expect(view.commissions.find((c: { payee_type: string }) => c.payee_type === 'seller')).toBeUndefined();
  });

  it('pays sellers when the plan has a seller line, and accrues per seller', async () => {
    const plan2 = await pool.query(
      `INSERT INTO commission_plans (name, effective_from, active) VALUES ('WithSeller','2026-01-01',true) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO commission_plan_lines (plan_id, payee_role, calc_type, value)
       VALUES ($1,'organization','flat_per_unit',12.00),
              ($1,'distributor','percent_of_retail',0.1250),
              ($1,'seller','percent_of_retail',0.0500)`,
      [plan2.rows[0].id],
    );
    const saleId = await runSaleToDelivered({
      planId: plan2.rows[0].id,
      quantity: 4,
      sellerCode: 'NS-JORDAN',
    });
    const s = await settleSale(saleId, null);
    expect(s.seller_commission).toBe('9.00'); // 0.05 * 180
    expect(s.gross_profit).toBe('26.50'); // 180 - 48 - 22.50 - 9 - 74

    const view = await getSettlement(saleId);
    const seller = view.commissions.find((c: { payee_type: string }) => c.payee_type === 'seller');
    expect(seller.amount).toBe('9.00');
  });

  it('refuses to settle a sale that is not delivered, and refuses double settlement', async () => {
    const sale = await createSale({
      organizationId: orgId,
      name: 'Undelivered',
      skus: [{ skuId }],
      createdBy: null,
    });
    await openSale(sale.id);
    await expect(settleSale(sale.id, null)).rejects.toMatchObject({ status: 409 });

    const settled = await runSaleToDelivered({ quantity: 4 });
    await settleSale(settled, null);
    await expect(settleSale(settled, null)).rejects.toMatchObject({ status: 409 });
  });
});
