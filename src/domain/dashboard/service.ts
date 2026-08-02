import { pool } from '../../db/pool.js';
import { marginReport } from '../reports/service.js';
import { sellerLeaderboard } from '../reports/service.js';
import { reorderList } from '../forecast/service.js';

// The owner dashboard (Phase 3): one read-only rollup of the whole business.
// It reuses the same aggregates the operational reports use, so the numbers on
// the owner's screen reconcile with the reports by construction. Money stays a
// Postgres NUMERIC and comes back as a string, never a float.
//
// Revenue and margin count order lines on open orders in sales that are past
// draft and not cancelled -- the same base the margin report uses.

export interface OwnerSummary {
  headline: {
    revenue: string;
    units: string;
    gross_margin: string;
    order_count: string;
    active_teams: string;
  };
  by_entity_channel: Awaited<ReturnType<typeof marginReport>>;
  pipeline: { status: string; sales: string }[];
  inventory: {
    skus: string;
    on_hand_units: string;
    negative_lines: string;
    reorder_alerts: string;
  };
  reorder_alerts: Awaited<ReturnType<typeof reorderList>>;
  top_sellers: Awaited<ReturnType<typeof sellerLeaderboard>>;
}

export async function ownerSummary(): Promise<OwnerSummary> {
  const headlineQ = pool.query<{
    revenue: string;
    units: string;
    gross_margin: string;
    order_count: string;
  }>(
    `SELECT ROUND(COALESCE(SUM(ol.extended),0), 2)::text AS revenue,
            COALESCE(SUM(ol.quantity),0)::text AS units,
            ROUND(COALESCE(SUM(ol.extended),0)
                  - COALESCE(SUM(ol.quantity * COALESCE(s.product_cost,0)),0), 2)::text AS gross_margin,
            COUNT(DISTINCT o.id)::text AS order_count
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id AND o.status = 'open'
       JOIN skus s ON s.id = ol.sku_id
       JOIN campaigns c ON c.id = o.campaign_id AND c.status NOT IN ('draft','cancelled')`,
  );

  // Teams with a sale currently in flight (open, finalized, or picking).
  const activeTeamsQ = pool.query<{ active_teams: string }>(
    `SELECT COUNT(DISTINCT organization_id)::text AS active_teams
       FROM campaigns
      WHERE deleted_at IS NULL AND status IN ('open','finalized','picking')`,
  );

  const pipelineQ = pool.query<{ status: string; sales: string }>(
    `SELECT status, COUNT(*)::text AS sales
       FROM campaigns WHERE deleted_at IS NULL
      GROUP BY status ORDER BY status`,
  );

  const inventoryQ = pool.query<{ skus: string; on_hand_units: string; negative_lines: string }>(
    `SELECT COUNT(DISTINCT sku_id)::text AS skus,
            COALESCE(SUM(quantity_on_hand),0)::text AS on_hand_units,
            COUNT(*) FILTER (WHERE quantity_on_hand < 0)::text AS negative_lines
       FROM inventory_snapshots`,
  );

  const [headline, activeTeams, pipeline, inventory, byEntityChannel, reorder, sellers] =
    await Promise.all([
      headlineQ,
      activeTeamsQ,
      pipelineQ,
      inventoryQ,
      marginReport({}),
      reorderList(),
      sellerLeaderboard({}),
    ]);

  const topSellers = sellers.filter((s) => Number(s.revenue) > 0).slice(0, 5);

  return {
    headline: {
      revenue: headline.rows[0]!.revenue,
      units: headline.rows[0]!.units,
      gross_margin: headline.rows[0]!.gross_margin,
      order_count: headline.rows[0]!.order_count,
      active_teams: activeTeams.rows[0]!.active_teams,
    },
    by_entity_channel: byEntityChannel,
    pipeline: pipeline.rows,
    inventory: {
      skus: inventory.rows[0]!.skus,
      on_hand_units: inventory.rows[0]!.on_hand_units,
      negative_lines: inventory.rows[0]!.negative_lines,
      reorder_alerts: String(reorder.length),
    },
    reorder_alerts: reorder,
    top_sellers: topSellers,
  };
}
