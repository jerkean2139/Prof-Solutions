import { pool, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import { emitGhlEvent } from '../../integrations/ghl/outbound.js';

// Settlement turns a delivered sale into money owed. Every rate comes from the
// commission plan locked to the sale (rule 3: nothing hardcoded). All money math
// runs in Postgres NUMERIC, never a JS float. Rounds to 2 decimals for storage.
//
// Payout basis:
//   flat_per_unit      -> value * units
//   percent_of_retail  -> value * gross revenue
// Organization and distributor apply to the whole sale. Seller applies to the
// revenue/units on orders that carry a seller. If the plan has no line for a
// role, that payout is zero.

export interface SettlementView {
  campaign_id: string;
  gross_revenue: string;
  organization_payout: string;
  distributor_commission: string;
  seller_commission: string;
  product_cost_total: string;
  gross_profit: string;
  status: string;
}

async function computeTotals(campaignId: string, planId: string) {
  const { rows } = await pool.query<{
    units: string;
    revenue: string;
    cost: string;
    org_payout: string;
    dist_commission: string;
    seller_commission: string;
    gross_profit: string;
  }>(
    `WITH lines AS (
       SELECT ol.quantity, ol.extended, s.product_cost, o.seller_id
         FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id AND o.status = 'open'
         JOIN skus s ON s.id = ol.sku_id
        WHERE o.campaign_id = $1
     ),
     agg AS (
       SELECT COALESCE(SUM(quantity),0)::numeric AS units,
              COALESCE(SUM(extended),0)::numeric AS revenue,
              COALESCE(SUM(quantity * COALESCE(product_cost,0)),0)::numeric AS cost,
              COALESCE(SUM(CASE WHEN seller_id IS NOT NULL THEN quantity ELSE 0 END),0)::numeric AS s_units,
              COALESCE(SUM(CASE WHEN seller_id IS NOT NULL THEN extended ELSE 0 END),0)::numeric AS s_revenue
         FROM lines
     ),
     line_for AS (
       -- one row per role with its value and calc_type (latest wins)
       SELECT payee_role,
              (ARRAY_AGG(value ORDER BY created_at DESC))[1] AS value,
              (ARRAY_AGG(calc_type ORDER BY created_at DESC))[1] AS calc_type
         FROM commission_plan_lines
        WHERE plan_id = $2 AND deleted_at IS NULL
        GROUP BY payee_role
     ),
     plan AS (
       SELECT
         (SELECT value FROM line_for WHERE payee_role='organization') AS org_val,
         (SELECT calc_type FROM line_for WHERE payee_role='organization') AS org_calc,
         (SELECT value FROM line_for WHERE payee_role='distributor') AS dist_val,
         (SELECT calc_type FROM line_for WHERE payee_role='distributor') AS dist_calc,
         (SELECT value FROM line_for WHERE payee_role='seller') AS seller_val,
         (SELECT calc_type FROM line_for WHERE payee_role='seller') AS seller_calc
     ),
     calc AS (
       SELECT
         agg.units,
         agg.revenue,
         ROUND(agg.cost, 2) AS cost,
         ROUND(CASE WHEN plan.org_calc='flat_per_unit' THEN COALESCE(plan.org_val,0)*agg.units
                    WHEN plan.org_calc='percent_of_retail' THEN COALESCE(plan.org_val,0)*agg.revenue
                    ELSE 0 END, 2) AS org_payout,
         ROUND(CASE WHEN plan.dist_calc='flat_per_unit' THEN COALESCE(plan.dist_val,0)*agg.units
                    WHEN plan.dist_calc='percent_of_retail' THEN COALESCE(plan.dist_val,0)*agg.revenue
                    ELSE 0 END, 2) AS dist_commission,
         ROUND(CASE WHEN plan.seller_calc='flat_per_unit' THEN COALESCE(plan.seller_val,0)*agg.s_units
                    WHEN plan.seller_calc='percent_of_retail' THEN COALESCE(plan.seller_val,0)*agg.s_revenue
                    ELSE 0 END, 2) AS seller_commission
       FROM agg, plan
     )
     -- gross_profit is derived from the ROUNDED components so the settlement
     -- always reconciles to the penny.
     SELECT units, revenue, cost, org_payout, dist_commission, seller_commission,
            (revenue - org_payout - dist_commission - seller_commission - cost) AS gross_profit
       FROM calc`,
    [campaignId, planId],
  );
  return rows[0]!;
}

// Per-seller commission for the ledger, using the same seller line.
async function perSellerAmounts(campaignId: string, planId: string) {
  const { rows } = await pool.query<{ seller_id: string; amount: string }>(
    `WITH sline AS (
       SELECT (ARRAY_AGG(value ORDER BY created_at DESC))[1] AS value,
              (ARRAY_AGG(calc_type ORDER BY created_at DESC))[1] AS calc_type
         FROM commission_plan_lines
        WHERE plan_id=$2 AND payee_role='seller' AND deleted_at IS NULL
     )
     SELECT o.seller_id,
            ROUND(CASE WHEN sline.calc_type='flat_per_unit' THEN COALESCE(sline.value,0)*SUM(ol.quantity)
                       WHEN sline.calc_type='percent_of_retail' THEN COALESCE(sline.value,0)*SUM(ol.extended)
                       ELSE 0 END, 2) AS amount
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id AND o.status='open'
       CROSS JOIN sline
      WHERE o.campaign_id=$1 AND o.seller_id IS NOT NULL
      GROUP BY o.seller_id, sline.calc_type, sline.value`,
    [campaignId, planId],
  );
  return rows.filter((r) => Number(r.amount) > 0);
}

export async function settleSale(saleId: string, settledBy: string | null): Promise<SettlementView> {
  const camp = await pool.query<{ status: string; commission_plan_id: string; rep_id: string | null; ghl: string | null }>(
    `SELECT c.status, c.commission_plan_id, c.rep_id, o.ghl_contact_id AS ghl
       FROM campaigns c JOIN organizations o ON o.id = c.organization_id
      WHERE c.id=$1 AND c.deleted_at IS NULL`,
    [saleId],
  );
  if (camp.rowCount === 0) throw notFound(`sale ${saleId} not found`);
  const { status, commission_plan_id: planId, rep_id: repId } = camp.rows[0]!;
  if (status === 'settled') throw conflict('sale is already settled');
  if (status !== 'delivered') throw conflict(`a sale can only be settled after delivery (sale is ${status})`);
  if (!planId) throw badRequest('sale has no commission plan locked; cannot settle');

  const totals = await computeTotals(saleId, planId);
  const sellerAmounts = await perSellerAmounts(saleId, planId);

  const settlement = await withTransaction(async (client) => {
    const s = await client.query<SettlementView>(
      `INSERT INTO campaign_settlements
         (campaign_id, gross_revenue, organization_payout, distributor_commission,
          seller_commission, product_cost_total, gross_profit, status, settled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'settled', now(), $8)
       RETURNING campaign_id, gross_revenue, organization_payout, distributor_commission,
                 seller_commission, product_cost_total, gross_profit, status`,
      [
        saleId,
        totals.revenue,
        totals.org_payout,
        totals.dist_commission,
        totals.seller_commission,
        totals.cost,
        totals.gross_profit,
        settledBy,
      ],
    );

    // Distributor (rep) accrues its commission.
    if (repId && Number(totals.dist_commission) > 0) {
      await client.query(
        `INSERT INTO commission_ledger (payee_type, payee_id, campaign_id, amount, status, created_by)
         VALUES ('rep',$1,$2,$3,'accrued',$4)`,
        [repId, saleId, totals.dist_commission, settledBy],
      );
    }
    // Each attributed seller accrues theirs.
    for (const row of sellerAmounts) {
      await client.query(
        `INSERT INTO commission_ledger (payee_type, payee_id, campaign_id, amount, status, created_by)
         VALUES ('seller',$1,$2,$3,'accrued',$4)`,
        [row.seller_id, saleId, row.amount, settledBy],
      );
    }

    await client.query(`UPDATE campaigns SET status='settled' WHERE id=$1`, [saleId]);
    return s.rows[0]!;
  });

  return settlement;
}

// Payout lifecycle for an accrued commission: accrued -> approved -> paid.
export async function approveCommission(commissionId: string, approvedBy: string | null) {
  const cur = await pool.query<{ status: string }>(
    `SELECT status FROM commission_ledger WHERE id=$1 AND deleted_at IS NULL`,
    [commissionId],
  );
  if (cur.rowCount === 0) throw notFound(`commission ${commissionId} not found`);
  if (cur.rows[0]!.status !== 'accrued') {
    throw conflict(`can only approve an accrued commission (is ${cur.rows[0]!.status})`);
  }
  const { rows } = await pool.query(
    `UPDATE commission_ledger SET status='approved', approved_by=$2 WHERE id=$1
     RETURNING id, payee_type, payee_id, amount, status`,
    [commissionId, approvedBy],
  );
  return rows[0];
}

export async function payCommission(commissionId: string) {
  const cur = await pool.query<{ status: string }>(
    `SELECT status FROM commission_ledger WHERE id=$1 AND deleted_at IS NULL`,
    [commissionId],
  );
  if (cur.rowCount === 0) throw notFound(`commission ${commissionId} not found`);
  if (cur.rows[0]!.status !== 'approved') {
    throw conflict(`can only pay an approved commission (is ${cur.rows[0]!.status})`);
  }
  const { rows } = await pool.query(
    `UPDATE commission_ledger SET status='paid', paid_at=now() WHERE id=$1
     RETURNING id, payee_type, payee_id, amount, status, paid_at`,
    [commissionId],
  );
  return rows[0];
}

// List commissions for a payout run, filterable by payee and status.
export async function listCommissions(filter: {
  payeeType?: string;
  payeeId?: string;
  status?: string;
}) {
  const conditions = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  for (const [col, val] of [
    ['payee_type', filter.payeeType],
    ['payee_id', filter.payeeId],
    ['status', filter.status],
  ] as const) {
    if (val) {
      params.push(val);
      conditions.push(`${col} = $${params.length}`);
    }
  }
  // Enrich with a human-readable payee name and the sale name, so a payout run
  // reads without a second lookup. payee_id points at reps or sellers depending
  // on payee_type; join both and coalesce.
  const prefixed = conditions.map((c) => (c === 'deleted_at IS NULL' ? 'cl.deleted_at IS NULL' : `cl.${c}`));
  const { rows } = await pool.query(
    `SELECT cl.id, cl.payee_type, cl.payee_id, cl.campaign_id,
            c.name AS campaign_name,
            COALESCE(r.display_name, se.display_name, se.seller_code) AS payee_name,
            cl.amount, cl.status, cl.approved_by, cl.paid_at
       FROM commission_ledger cl
       LEFT JOIN campaigns c ON c.id = cl.campaign_id
       LEFT JOIN reps r ON r.id = cl.payee_id AND cl.payee_type = 'rep'
       LEFT JOIN sellers se ON se.id = cl.payee_id AND cl.payee_type = 'seller'
      WHERE ${prefixed.join(' AND ')}
      ORDER BY cl.created_at DESC`,
    params,
  );
  return rows;
}

export async function getSettlement(saleId: string) {
  const s = await pool.query(
    `SELECT campaign_id, gross_revenue, organization_payout, distributor_commission,
            seller_commission, product_cost_total, gross_profit, status, settled_at
       FROM campaign_settlements WHERE campaign_id=$1`,
    [saleId],
  );
  if (s.rowCount === 0) throw notFound(`no settlement for sale ${saleId}`);
  const ledger = await pool.query(
    `SELECT payee_type, payee_id, amount, status FROM commission_ledger WHERE campaign_id=$1 ORDER BY payee_type`,
    [saleId],
  );
  return { ...s.rows[0], commissions: ledger.rows };
}
