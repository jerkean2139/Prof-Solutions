import { pool, withTransaction } from '../../db/pool.js';

// Demand forecasting and reorder points, derived from order history. This reads
// order and ledger data and NEVER writes inventory (rule 10 territory: the
// ledger is untouched here).
//
// The model is deliberately simple and documented, not a black box:
//   monthly demand   = historical units sold / months of history (min 1)
//   projected_units  = ceil(monthly demand)
//   reorder_point    = one month of projected demand
// When on-hand available falls to the reorder point, it is time to buy. As more
// history accumulates this can be replaced with a smarter model without moving
// anything else.

async function warehouseForSku(skuId: string): Promise<string | null> {
  const snap = await pool.query<{ warehouse_id: string }>(
    `SELECT warehouse_id FROM inventory_snapshots WHERE sku_id=$1
      ORDER BY quantity_on_hand DESC, warehouse_id ASC LIMIT 1`,
    [skuId],
  );
  if (snap.rows[0]) return snap.rows[0].warehouse_id;
  const wh = await pool.query<{ id: string }>(
    `SELECT id FROM warehouses WHERE active=true AND deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
  );
  return wh.rows[0]?.id ?? null;
}

export async function rebuildForecasts() {
  const demand = await pool.query<{ sku_id: string; units: string; months: string }>(
    `SELECT ol.sku_id,
            SUM(ol.quantity) AS units,
            GREATEST(1, COUNT(DISTINCT date_trunc('month', o.created_at))) AS months
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id AND o.status = 'open'
       JOIN campaigns c ON c.id = o.campaign_id AND c.status NOT IN ('draft','cancelled')
      GROUP BY ol.sku_id`,
  );

  const written: { sku_id: string; projected_units: number; reorder_point: number }[] = [];
  await withTransaction(async (client) => {
    // Rebuild the monthly forecast set from scratch.
    await client.query(`DELETE FROM demand_forecasts WHERE period='monthly'`);
    for (const row of demand.rows) {
      const warehouseId = await warehouseForSku(row.sku_id);
      if (!warehouseId) continue;
      const monthly = Math.ceil(Number(row.units) / Number(row.months));
      const reorderPoint = monthly; // one month of demand
      await client.query(
        `INSERT INTO demand_forecasts (sku_id, warehouse_id, period, projected_units, reorder_point, computed_at)
         VALUES ($1,$2,'monthly',$3,$4, now())`,
        [row.sku_id, warehouseId, monthly, reorderPoint],
      );
      written.push({ sku_id: row.sku_id, projected_units: monthly, reorder_point: reorderPoint });
    }
  });
  return written;
}

export async function listForecasts() {
  const { rows } = await pool.query(
    `SELECT f.sku_id, s.sku_code, f.warehouse_id, f.period, f.projected_units, f.reorder_point, f.computed_at
       FROM demand_forecasts f JOIN skus s ON s.id = f.sku_id
      WHERE f.period='monthly'
      ORDER BY s.sku_code`,
  );
  return rows;
}

// SKUs whose available stock has fallen to or below the reorder point, with a
// suggested quantity to bring them back to two months of cover.
export async function reorderList() {
  const { rows } = await pool.query(
    `WITH avail AS (
       SELECT sku_id, SUM(quantity_available) AS available
         FROM inventory_snapshots GROUP BY sku_id
     )
     SELECT f.sku_id,
            s.sku_code,
            f.projected_units,
            f.reorder_point,
            COALESCE(a.available, 0) AS available,
            GREATEST(2 * f.projected_units - COALESCE(a.available, 0), f.projected_units) AS suggested_order
       FROM demand_forecasts f
       JOIN skus s ON s.id = f.sku_id
       LEFT JOIN avail a ON a.sku_id = f.sku_id
      WHERE f.period='monthly' AND COALESCE(a.available, 0) <= f.reorder_point
      ORDER BY s.sku_code`,
  );
  return rows;
}
