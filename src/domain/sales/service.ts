import { pool, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import { refreshSnapshotForSku } from '../../inventory/snapshot.js';
import { emitGhlEvent } from '../../integrations/ghl/outbound.js';

// A sale is a team's fundraising campaign. The org-facing word is "sale"; the
// table is campaigns. The commission plan is locked at creation so a later rate
// change never moves a sale that already ran. The close is group-triggered:
// the team finalizes, there is no calendar deadline.

async function activePlanId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM commission_plans
      WHERE active = true AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY effective_from DESC LIMIT 1`,
  );
  if (rows.length === 0) throw badRequest('no active commission plan to lock to the sale');
  return rows[0]!.id;
}

export interface CreateSaleInput {
  organizationId: string;
  name: string;
  repId?: string;
  commissionPlanId?: string;
  channel?: 'fundraising' | 'retail';
  startsOn?: string;
  goalAmount?: string;
  skus: { skuId: string; priceOverride?: string }[];
  createdBy: string | null;
}

export async function createSale(input: CreateSaleInput) {
  const org = await pool.query(`SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL`, [
    input.organizationId,
  ]);
  if (org.rowCount === 0) throw notFound(`organization ${input.organizationId} not found`);
  if (input.skus.length === 0) throw badRequest('a sale needs at least one SKU');

  const planId = input.commissionPlanId ?? (await activePlanId());

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO campaigns
         (organization_id, rep_id, name, channel, commission_plan_id, starts_on, goal_amount, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
       RETURNING id, organization_id, name, channel, status, commission_plan_id`,
      [
        input.organizationId,
        input.repId ?? null,
        input.name,
        input.channel ?? 'fundraising',
        planId,
        input.startsOn ?? null,
        input.goalAmount ?? null,
        input.createdBy,
      ],
    );
    const sale = rows[0];
    for (const s of input.skus) {
      await client.query(
        `INSERT INTO campaign_skus (campaign_id, sku_id, price_override, created_by)
         VALUES ($1,$2,$3,$4)`,
        [sale.id, s.skuId, s.priceOverride ?? null, input.createdBy],
      );
    }
    return sale;
  });
}

// Move a sale to a target status with the allowed transitions enforced.
const TRANSITIONS: Record<string, string[]> = {
  draft: ['open', 'cancelled'],
  open: ['finalized', 'cancelled'],
  finalized: ['picking', 'cancelled'],
  picking: ['delivered', 'cancelled'],
  delivered: ['settled'],
};

async function currentStatus(saleId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM campaigns WHERE id=$1 AND deleted_at IS NULL`,
    [saleId],
  );
  if (rows.length === 0) throw notFound(`sale ${saleId} not found`);
  return rows[0]!.status;
}

export async function openSale(saleId: string) {
  const status = await currentStatus(saleId);
  if (!TRANSITIONS[status]?.includes('open')) {
    throw conflict(`cannot open a sale that is ${status}`);
  }
  const { rows } = await pool.query(
    `UPDATE campaigns SET status='open' WHERE id=$1 RETURNING id, status`,
    [saleId],
  );
  return rows[0];
}

// List sales, newest first, optionally filtered by organization and status.
export async function listSales(filter: { organizationId?: string; status?: string }) {
  const conditions = ['c.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filter.organizationId) {
    params.push(filter.organizationId);
    conditions.push(`c.organization_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`c.status = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.status, c.channel, c.organization_id, o.name AS organization_name,
            c.goal_amount, c.next_sale_target, c.created_at
       FROM campaigns c JOIN organizations o ON o.id = c.organization_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at DESC`,
    params,
  );
  return rows;
}

// The products offered in a sale, with the effective price (override or SKU
// price). This is what the order-entry screen loads once and matches typed
// codes against, so there is no round trip per line.
export async function getSaleSkus(saleId: string) {
  const { rows } = await pool.query(
    `SELECT cs.sku_id, s.sku_code, p.name AS product_name, s.unit_config,
            COALESCE(cs.price_override, s.retail_price) AS price
       FROM campaign_skus cs
       JOIN skus s ON s.id = cs.sku_id
       JOIN products p ON p.id = s.product_id
      WHERE cs.campaign_id = $1 AND cs.deleted_at IS NULL
      ORDER BY s.sku_code`,
    [saleId],
  );
  return rows;
}

export async function getSale(saleId: string) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.status, c.channel, c.organization_id, c.finalized_at,
            c.goal_amount, c.next_sale_target, c.incentive_note
       FROM campaigns c WHERE c.id=$1 AND c.deleted_at IS NULL`,
    [saleId],
  );
  if (rows.length === 0) throw notFound(`sale ${saleId} not found`);
  return rows[0];
}

export interface FinalizeInput {
  finalizedBy: string;
  nextSaleTarget?: string;
  incentiveNote?: string;
}

// Group-triggered close. Locks totals, commits inventory to the sale, and starts
// the growth loop through GHL. A sale cannot finalize with zero orders.
export async function finalizeSale(saleId: string, input: FinalizeInput) {
  const status = await currentStatus(saleId);
  if (status !== 'open') throw conflict(`cannot finalize a sale that is ${status}`);

  const orderCount = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM orders WHERE campaign_id=$1 AND status='open'`,
    [saleId],
  );
  if (Number(orderCount.rows[0]!.n) === 0) {
    throw badRequest('cannot finalize a sale with zero orders; cancel it instead');
  }

  // SKUs whose committed quantity is about to change.
  const skuRows = await pool.query<{ sku_id: string }>(
    `SELECT DISTINCT ol.sku_id
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE o.campaign_id=$1 AND o.status='open'`,
    [saleId],
  );

  const totals = await pool.query<{ raised: string; units: string }>(
    `SELECT COALESCE(SUM(ol.extended),0) AS raised, COALESCE(SUM(ol.quantity),0) AS units
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE o.campaign_id=$1 AND o.status='open'`,
    [saleId],
  );

  const { rows } = await pool.query(
    `UPDATE campaigns
        SET status='finalized', finalized_at=now(), finalized_by=$2,
            next_sale_target=$3, incentive_note=$4
      WHERE id=$1
      RETURNING id, status, finalized_at, next_sale_target`,
    [saleId, input.finalizedBy, input.nextSaleTarget ?? null, input.incentiveNote ?? null],
  );
  const sale = rows[0];

  // Now that the sale is finalized, its order quantities are committed. Refresh
  // each affected SKU's snapshot so available reflects the commitment.
  for (const r of skuRows.rows) await refreshSnapshotForSku(r.sku_id);

  // Push totals and start the growth loop. GHL owns the messages.
  const org = await pool.query<{ ghl_contact_id: string; id: string }>(
    `SELECT o.ghl_contact_id, o.id FROM organizations o
       JOIN campaigns c ON c.organization_id = o.id WHERE c.id=$1`,
    [saleId],
  );
  const ghlContactId = org.rows[0]?.ghl_contact_id;
  if (ghlContactId) {
    await emitGhlEvent('sale.finalized', {
      targetId: ghlContactId,
      tags: ['sale-complete'],
      customFields: {
        sale_total_raised: totals.rows[0]!.raised,
        sale_unit_count: Number(totals.rows[0]!.units),
      },
    });
    if (input.nextSaleTarget) {
      await emitGhlEvent('growth.next_sale', {
        targetId: ghlContactId,
        tags: ['next-sale-eligible'],
        customFields: {
          next_sale_target: input.nextSaleTarget,
          incentive: input.incentiveNote ?? '',
        },
      });
    }
  }

  return sale;
}
