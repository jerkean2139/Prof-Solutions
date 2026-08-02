import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import { refreshSnapshotForSku } from '../../inventory/snapshot.js';
import { emitGhlEvent } from '../../integrations/ghl/outbound.js';

// Fulfillment. A finalized sale is aggregated into one bulk pick list (one line
// per SKU, summed across all orders). Completing a pick line is the only path
// that decrements inventory: it writes a negative pick transaction to the
// append-only ledger. The team gets one bulk shipment, not per-buyer boxes.

async function saleStatus(saleId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM campaigns WHERE id=$1 AND deleted_at IS NULL`,
    [saleId],
  );
  if (rows.length === 0) throw notFound(`sale ${saleId} not found`);
  return rows[0]!.status;
}

export interface PickListLineView {
  id: string;
  sku_id: string;
  sku_code: string;
  quantity_required: number;
  quantity_picked: number;
  quantity_on_hand: number;
  short: boolean;
  shortage: number;
}

// Generate the bulk pick list from a finalized sale and move it to picking.
export async function generatePickList(saleId: string, createdBy: string | null) {
  const status = await saleStatus(saleId);
  if (status !== 'finalized') {
    throw conflict(`a pick list can only be generated from a finalized sale (sale is ${status})`);
  }

  // Compare demand against physical on-hand. Committed already includes this
  // sale, so using available here would double-count the sale's own demand.
  // Picking draws from what is physically on the shelf.
  const agg = await pool.query<{ sku_id: string; sku_code: string; qty: string; on_hand: string }>(
    `SELECT ol.sku_id,
            s.sku_code,
            SUM(ol.quantity) AS qty,
            COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_snapshots WHERE sku_id = ol.sku_id), 0) AS on_hand
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id AND o.status = 'open'
       JOIN skus s ON s.id = ol.sku_id
      WHERE o.campaign_id = $1
      GROUP BY ol.sku_id, s.sku_code
      ORDER BY s.sku_code`,
    [saleId],
  );
  if (agg.rowCount === 0) throw badRequest('sale has no order lines to pick');

  const pickListNumber = `PL-${randomUUID().slice(0, 8).toUpperCase()}`;

  const result = await withTransaction(async (client) => {
    const pl = await client.query<{ id: string; pick_list_number: string }>(
      `INSERT INTO pick_lists (campaign_id, pick_list_number, status, created_by)
       VALUES ($1,$2,'generated',$3) RETURNING id, pick_list_number`,
      [saleId, pickListNumber, createdBy],
    );
    const pickListId = pl.rows[0]!.id;

    const lines: PickListLineView[] = [];
    for (const row of agg.rows) {
      const required = Number(row.qty);
      const onHand = Number(row.on_hand);
      const line = await client.query<{ id: string }>(
        `INSERT INTO pick_list_lines (pick_list_id, sku_id, quantity_required, quantity_picked, created_by)
         VALUES ($1,$2,$3,0,$4) RETURNING id`,
        [pickListId, row.sku_id, required, createdBy],
      );
      const shortage = Math.max(0, required - onHand);
      lines.push({
        id: line.rows[0]!.id,
        sku_id: row.sku_id,
        sku_code: row.sku_code,
        quantity_required: required,
        quantity_picked: 0,
        quantity_on_hand: onHand,
        short: shortage > 0,
        shortage,
      });
    }

    // The sale is now being picked. Inventory stays committed to it.
    await client.query(`UPDATE campaigns SET status='picking' WHERE id=$1`, [saleId]);

    return {
      pick_list_id: pickListId,
      pick_list_number: pl.rows[0]!.pick_list_number,
      short: lines.some((l) => l.short),
      lines,
    };
  });

  return result;
}

// Read the current (latest, not cancelled) pick list for a sale, with live
// on-hand and shortage per line. Same shape as generatePickList's return, so the
// picking screen renders identically whether it just generated or is reloading.
export async function getPickListForSale(saleId: string) {
  const pl = await pool.query<{ id: string; pick_list_number: string; status: string }>(
    `SELECT id, pick_list_number, status
       FROM pick_lists
      WHERE campaign_id=$1 AND deleted_at IS NULL AND status <> 'cancelled'
      ORDER BY created_at DESC LIMIT 1`,
    [saleId],
  );
  if (pl.rowCount === 0) return null;
  const pickListId = pl.rows[0]!.id;

  const lineRows = await pool.query<{
    id: string;
    sku_id: string;
    sku_code: string;
    quantity_required: number;
    quantity_picked: number;
    on_hand: string;
  }>(
    `SELECT pll.id, pll.sku_id, s.sku_code, pll.quantity_required, pll.quantity_picked,
            COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_snapshots WHERE sku_id = pll.sku_id), 0) AS on_hand
       FROM pick_list_lines pll JOIN skus s ON s.id = pll.sku_id
      WHERE pll.pick_list_id=$1 AND pll.deleted_at IS NULL
      ORDER BY s.sku_code`,
    [pickListId],
  );

  const lines: PickListLineView[] = lineRows.rows.map((row) => {
    const onHand = Number(row.on_hand);
    const remaining = Math.max(0, row.quantity_required - row.quantity_picked);
    const shortage = Math.max(0, remaining - onHand);
    return {
      id: row.id,
      sku_id: row.sku_id,
      sku_code: row.sku_code,
      quantity_required: row.quantity_required,
      quantity_picked: row.quantity_picked,
      quantity_on_hand: onHand,
      short: shortage > 0,
      shortage,
    };
  });

  return {
    pick_list_id: pickListId,
    pick_list_number: pl.rows[0]!.pick_list_number,
    status: pl.rows[0]!.status,
    short: lines.some((l) => l.short),
    lines,
  };
}

// Resolve which warehouse a pick draws from. The UI assumes one warehouse; the
// schema supports many. Prefer the SKU's primary (most on-hand), else the sole
// active warehouse.
async function resolvePickWarehouse(skuId: string, warehouseId?: string): Promise<string> {
  if (warehouseId) return warehouseId;
  const snap = await pool.query<{ warehouse_id: string }>(
    `SELECT warehouse_id FROM inventory_snapshots WHERE sku_id=$1
      ORDER BY quantity_on_hand DESC, warehouse_id ASC LIMIT 1`,
    [skuId],
  );
  if (snap.rows[0]) return snap.rows[0].warehouse_id;
  const wh = await pool.query<{ id: string }>(
    `SELECT id FROM warehouses WHERE active = true AND deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
  );
  if (wh.rows[0]) return wh.rows[0].id;
  throw badRequest('no warehouse available to pick from');
}

export interface PickLineInput {
  quantityPicked: number;
  lotId?: string;
  warehouseId?: string;
  pickedBy: string | null;
}

// Complete (or partially complete) a pick line. This is the only path that
// decrements stock: it writes a negative pick transaction to the ledger.
// Negative on-hand is allowed but surfaces on the discrepancy report.
export async function pickLine(pickListLineId: string, input: PickLineInput) {
  if (!Number.isInteger(input.quantityPicked) || input.quantityPicked <= 0) {
    throw badRequest('quantityPicked must be a positive integer');
  }

  const lineRow = await pool.query<{ sku_id: string; pick_list_id: string; pl_status: string }>(
    `SELECT pll.sku_id, pll.pick_list_id, pl.status AS pl_status
       FROM pick_list_lines pll JOIN pick_lists pl ON pl.id = pll.pick_list_id
      WHERE pll.id=$1 AND pll.deleted_at IS NULL`,
    [pickListLineId],
  );
  if (lineRow.rowCount === 0) throw notFound(`pick list line ${pickListLineId} not found`);
  const { sku_id: skuId, pick_list_id: pickListId, pl_status } = lineRow.rows[0]!;
  if (pl_status === 'complete' || pl_status === 'cancelled') {
    throw conflict(`pick list is ${pl_status}`);
  }

  const warehouseId = await resolvePickWarehouse(skuId, input.warehouseId);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO inventory_transactions
         (sku_id, warehouse_id, txn_type, quantity_delta, lot_id, reference_type, reference_id, created_by)
       VALUES ($1,$2,'pick',$3,$4,'pick_list',$5,$6)`,
      [skuId, warehouseId, -input.quantityPicked, input.lotId ?? null, pickListId, input.pickedBy],
    );
    await client.query(
      `UPDATE pick_list_lines
          SET quantity_picked = quantity_picked + $2,
              lot_id = COALESCE($3, lot_id),
              picked_by = $4,
              picked_at = now()
        WHERE id=$1`,
      [pickListLineId, input.quantityPicked, input.lotId ?? null, input.pickedBy],
    );
    if (pl_status === 'generated') {
      await client.query(`UPDATE pick_lists SET status='in_progress' WHERE id=$1`, [pickListId]);
    }
  });

  await refreshSnapshotForSku(skuId);

  const snap = await pool.query<{ quantity_on_hand: number }>(
    `SELECT quantity_on_hand FROM inventory_snapshots WHERE sku_id=$1 AND warehouse_id=$2`,
    [skuId, warehouseId],
  );
  return { pickListLineId, sku_id: skuId, warehouse_id: warehouseId, quantity_on_hand: snap.rows[0]?.quantity_on_hand ?? null };
}

export async function completePickList(pickListId: string) {
  const pl = await pool.query<{ status: string }>(`SELECT status FROM pick_lists WHERE id=$1`, [
    pickListId,
  ]);
  if (pl.rowCount === 0) throw notFound(`pick list ${pickListId} not found`);
  if (pl.rows[0]!.status === 'cancelled') throw conflict('pick list is cancelled');
  const { rows } = await pool.query(
    `UPDATE pick_lists SET status='complete', completed_at=now() WHERE id=$1 RETURNING id, status, completed_at`,
    [pickListId],
  );
  return rows[0];
}

export interface ShipmentInput {
  carrier?: string;
  trackingNumber?: string;
  createdBy: string | null;
}

// One bulk shipment to the team. Records the shipment, moves the sale to
// delivered (which releases the committed quantity), and pushes the tracking
// number to GHL so it notifies the team.
export async function createShipment(pickListId: string, input: ShipmentInput) {
  const pl = await pool.query<{ campaign_id: string; status: string }>(
    `SELECT campaign_id, status FROM pick_lists WHERE id=$1 AND deleted_at IS NULL`,
    [pickListId],
  );
  if (pl.rowCount === 0) throw notFound(`pick list ${pickListId} not found`);
  const saleId = pl.rows[0]!.campaign_id;
  const sStatus = await saleStatus(saleId);
  if (sStatus !== 'picking') {
    throw conflict(`can only ship from a sale that is picking (sale is ${sStatus})`);
  }

  // SKUs to refresh once the sale leaves the committed set.
  const skuRows = await pool.query<{ sku_id: string }>(
    `SELECT DISTINCT sku_id FROM pick_list_lines WHERE pick_list_id=$1`,
    [pickListId],
  );

  const packingSlipNumber = `PS-${randomUUID().slice(0, 8).toUpperCase()}`;

  const shipment = await withTransaction(async (client) => {
    const s = await client.query(
      `INSERT INTO shipments (pick_list_id, packing_slip_number, carrier, tracking_number, shipped_at, created_by)
       VALUES ($1,$2,$3,$4, now(), $5)
       RETURNING id, packing_slip_number, carrier, tracking_number, shipped_at`,
      [pickListId, packingSlipNumber, input.carrier ?? null, input.trackingNumber ?? null, input.createdBy],
    );
    await client.query(`UPDATE campaigns SET status='delivered' WHERE id=$1`, [saleId]);
    return s.rows[0];
  });

  // The sale is delivered; committed releases, on-hand already reflects picks.
  for (const r of skuRows.rows) await refreshSnapshotForSku(r.sku_id);

  const org = await pool.query<{ ghl_contact_id: string }>(
    `SELECT o.ghl_contact_id FROM organizations o
       JOIN campaigns c ON c.organization_id = o.id WHERE c.id=$1`,
    [saleId],
  );
  const ghlContactId = org.rows[0]?.ghl_contact_id;
  if (ghlContactId && input.trackingNumber) {
    await emitGhlEvent('shipment.sent', {
      targetId: ghlContactId,
      tags: ['shipment-sent'],
      customFields: { tracking_number: input.trackingNumber, carrier: input.carrier ?? '' },
    });
  }

  return shipment;
}

// The packing slip document: the pick list, its lines, the shipment, and the
// team it ships to. Rendered from records, not a separate table.
export async function getPackingSlip(pickListId: string) {
  const pl = await pool.query(
    `SELECT pl.id, pl.pick_list_number, pl.status, pl.completed_at,
            c.id AS sale_id, c.name AS sale_name,
            o.name AS organization_name, o.address_line1, o.address_city, o.address_state, o.address_postal
       FROM pick_lists pl
       JOIN campaigns c ON c.id = pl.campaign_id
       JOIN organizations o ON o.id = c.organization_id
      WHERE pl.id=$1 AND pl.deleted_at IS NULL`,
    [pickListId],
  );
  if (pl.rowCount === 0) throw notFound(`pick list ${pickListId} not found`);

  const lines = await pool.query(
    `SELECT pll.sku_id, s.sku_code, s.description, pll.quantity_required, pll.quantity_picked
       FROM pick_list_lines pll JOIN skus s ON s.id = pll.sku_id
      WHERE pll.pick_list_id=$1 ORDER BY s.sku_code`,
    [pickListId],
  );

  const shipment = await pool.query(
    `SELECT packing_slip_number, carrier, tracking_number, shipped_at
       FROM shipments WHERE pick_list_id=$1 ORDER BY shipped_at DESC LIMIT 1`,
    [pickListId],
  );

  return { ...pl.rows[0], lines: lines.rows, shipment: shipment.rows[0] ?? null };
}
