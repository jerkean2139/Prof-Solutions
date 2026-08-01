import { withTransaction } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

// Rule 1: on-hand is derived from the append-only ledger, cached for speed,
// never authoritative on its own. This module rebuilds the derived cache from
// scratch and must produce identical numbers every run. The rebuild is the
// proof that inventory_snapshots is only ever a cache.
//
// on-hand      = sum of quantity_delta from inventory_transactions
// committed    = order-line quantities on open orders in finalized/picking
//                sales (business rule: committing happens at finalize)
// available    = on-hand minus committed (a generated column in the table)
//
// Multi-warehouse note: campaigns and orders are not warehouse-scoped, and the
// UI assumes one warehouse. Committed demand for a SKU is attributed to that
// SKU's primary warehouse: the one holding the most on-hand, ties broken by
// warehouse_id ascending. With a single warehouse this is exactly correct, and
// it is deterministic, so the rebuild always reproduces the same numbers.

interface OnHandRow {
  sku_id: string;
  warehouse_id: string;
  on_hand: number;
}

interface DemandRow {
  sku_id: string;
  committed: number;
}

interface SnapshotRow {
  sku_id: string;
  warehouse_id: string;
  quantity_on_hand: number;
  quantity_committed: number;
}

export function computeSnapshotRows(
  onHand: OnHandRow[],
  demand: DemandRow[],
): SnapshotRow[] {
  const committedBySku = new Map<string, number>();
  for (const d of demand) committedBySku.set(d.sku_id, d.committed);

  // Group on-hand rows by SKU to pick each SKU's primary warehouse.
  const bySku = new Map<string, OnHandRow[]>();
  for (const row of onHand) {
    const list = bySku.get(row.sku_id) ?? [];
    list.push(row);
    bySku.set(row.sku_id, list);
  }

  const result: SnapshotRow[] = [];
  for (const [skuId, rows] of bySku) {
    const primary = [...rows].sort(
      (a, b) =>
        b.on_hand - a.on_hand ||
        (a.warehouse_id < b.warehouse_id ? -1 : a.warehouse_id > b.warehouse_id ? 1 : 0),
    )[0]!;
    const committed = committedBySku.get(skuId) ?? 0;
    for (const row of rows) {
      result.push({
        sku_id: row.sku_id,
        warehouse_id: row.warehouse_id,
        quantity_on_hand: row.on_hand,
        quantity_committed: row.warehouse_id === primary.warehouse_id ? committed : 0,
      });
    }
  }

  // Stable ordering so two rebuilds serialize identically.
  result.sort(
    (a, b) =>
      (a.sku_id < b.sku_id ? -1 : a.sku_id > b.sku_id ? 1 : 0) ||
      (a.warehouse_id < b.warehouse_id ? -1 : a.warehouse_id > b.warehouse_id ? 1 : 0),
  );
  return result;
}

export async function rebuildSnapshots(): Promise<SnapshotRow[]> {
  const onHand = (
    await pool.query<{ sku_id: string; warehouse_id: string; on_hand: string }>(
      `SELECT sku_id, warehouse_id, SUM(quantity_delta) AS on_hand
         FROM inventory_transactions
        GROUP BY sku_id, warehouse_id`,
    )
  ).rows.map((r) => ({
    sku_id: r.sku_id,
    warehouse_id: r.warehouse_id,
    on_hand: Number(r.on_hand),
  }));

  const demand = (
    await pool.query<{ sku_id: string; committed: string }>(
      `SELECT ol.sku_id, SUM(ol.quantity) AS committed
         FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id AND o.status = 'open'
         JOIN campaigns c ON c.id = o.campaign_id
        WHERE c.status IN ('finalized', 'picking')
        GROUP BY ol.sku_id`,
    )
  ).rows.map((r) => ({ sku_id: r.sku_id, committed: Number(r.committed) }));

  const rows = computeSnapshotRows(onHand, demand);

  await withTransaction(async (client) => {
    await client.query('DELETE FROM inventory_snapshots');
    for (const row of rows) {
      await client.query(
        `INSERT INTO inventory_snapshots
           (sku_id, warehouse_id, quantity_on_hand, quantity_committed, last_computed_at)
         VALUES ($1, $2, $3, $4, now())`,
        [row.sku_id, row.warehouse_id, row.quantity_on_hand, row.quantity_committed],
      );
    }
  });

  logger.info({ rows: rows.length }, 'inventory snapshots rebuilt from ledger');
  return rows;
}
