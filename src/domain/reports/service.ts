import { pool } from '../../db/pool.js';

// Reporting. Money is aggregated in Postgres NUMERIC and returned as strings.
// The margin report defaults to splitting by owner_entity and channel because
// the two legal entities' numbers must never blend (business rules).

export interface MarginRow {
  owner_entity: string;
  channel: string;
  units: string;
  revenue: string;
  product_cost: string;
  gross_margin: string;
}

export async function marginReport(filter: {
  ownerEntity?: string;
  channel?: string;
}): Promise<MarginRow[]> {
  const conditions: string[] = [`c.status NOT IN ('draft','cancelled')`];
  const params: unknown[] = [];
  if (filter.ownerEntity) {
    params.push(filter.ownerEntity);
    conditions.push(`p.owner_entity = $${params.length}`);
  }
  if (filter.channel) {
    params.push(filter.channel);
    conditions.push(`c.channel = $${params.length}`);
  }
  const { rows } = await pool.query<MarginRow>(
    `SELECT p.owner_entity,
            c.channel,
            SUM(ol.quantity)::text AS units,
            ROUND(SUM(ol.extended), 2)::text AS revenue,
            ROUND(SUM(ol.quantity * COALESCE(s.product_cost,0)), 2)::text AS product_cost,
            ROUND(SUM(ol.extended) - SUM(ol.quantity * COALESCE(s.product_cost,0)), 2)::text AS gross_margin
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id AND o.status = 'open'
       JOIN skus s ON s.id = ol.sku_id
       JOIN products p ON p.id = s.product_id
       JOIN campaigns c ON c.id = o.campaign_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY p.owner_entity, c.channel
      ORDER BY p.owner_entity, c.channel`,
    params,
  );
  return rows;
}

export interface LeaderboardRow {
  seller_id: string;
  display_name: string | null;
  seller_code: string;
  units: string;
  revenue: string;
}

// Per-seller units and revenue. Scope to an organization, and optionally a sale.
export async function sellerLeaderboard(filter: {
  organizationId?: string;
  campaignId?: string;
}): Promise<LeaderboardRow[]> {
  const params: unknown[] = [];
  const sellerWhere: string[] = ['sel.deleted_at IS NULL'];
  if (filter.organizationId) {
    params.push(filter.organizationId);
    sellerWhere.push(`sel.organization_id = $${params.length}`);
  }
  // Join condition for the campaign scope on the orders side.
  let orderJoin = `o.seller_id = sel.id AND o.status = 'open'`;
  if (filter.campaignId) {
    params.push(filter.campaignId);
    orderJoin += ` AND o.campaign_id = $${params.length}`;
  }
  const { rows } = await pool.query<LeaderboardRow>(
    `SELECT sel.id AS seller_id,
            sel.display_name,
            sel.seller_code,
            COALESCE(SUM(ol.quantity),0)::text AS units,
            ROUND(COALESCE(SUM(ol.extended),0), 2)::text AS revenue
       FROM sellers sel
       LEFT JOIN orders o ON ${orderJoin}
       LEFT JOIN order_lines ol ON ol.order_id = o.id
      WHERE ${sellerWhere.join(' AND ')}
      GROUP BY sel.id, sel.display_name, sel.seller_code
      ORDER BY COALESCE(SUM(ol.extended),0) DESC, COALESCE(SUM(ol.quantity),0) DESC`,
    params,
  );
  return rows;
}
