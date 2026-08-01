import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import { refreshSnapshotForSku } from '../../inventory/snapshot.js';

// Vendors and purchase orders. Receiving against a PO writes receipt
// transactions to the inventory ledger, linked to the PO. Money stays NUMERIC.

export interface CreateVendorInput {
  name: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  paymentTerms?: string;
  leadTimeDays?: number;
  createdBy: string | null;
}

export async function createVendor(input: CreateVendorInput) {
  const { rows } = await pool.query(
    `INSERT INTO vendors (name, contact_name, contact_email, contact_phone, payment_terms, lead_time_days, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, name, payment_terms, lead_time_days, active`,
    [
      input.name,
      input.contactName ?? null,
      input.contactEmail ?? null,
      input.contactPhone ?? null,
      input.paymentTerms ?? null,
      input.leadTimeDays ?? null,
      input.createdBy,
    ],
  );
  return rows[0];
}

export async function listVendors() {
  const { rows } = await pool.query(
    `SELECT id, name, contact_name, payment_terms, lead_time_days, active
       FROM vendors WHERE deleted_at IS NULL ORDER BY name`,
  );
  return rows;
}

export interface CreatePoInput {
  vendorId: string;
  lines: { skuId: string; quantityOrdered: number; unitCost: string }[];
  createdBy: string | null;
}

export async function createPurchaseOrder(input: CreatePoInput) {
  if (input.lines.length === 0) throw badRequest('a purchase order needs at least one line');
  const vendor = await pool.query(`SELECT id FROM vendors WHERE id=$1 AND deleted_at IS NULL`, [
    input.vendorId,
  ]);
  if (vendor.rowCount === 0) throw notFound(`vendor ${input.vendorId} not found`);

  const poNumber = `PO-${randomUUID().slice(0, 8).toUpperCase()}`;
  return withTransaction(async (client) => {
    const po = await client.query<{ id: string; po_number: string }>(
      `INSERT INTO purchase_orders (vendor_id, po_number, status, ordered_at, subtotal, created_by)
       VALUES ($1,$2,'ordered', now(), 0, $3) RETURNING id, po_number`,
      [input.vendorId, poNumber, input.createdBy],
    );
    const poId = po.rows[0]!.id;
    for (const l of input.lines) {
      if (!Number.isInteger(l.quantityOrdered) || l.quantityOrdered <= 0) {
        throw badRequest('each line quantityOrdered must be a positive integer');
      }
      await client.query(
        `INSERT INTO purchase_order_lines (po_id, sku_id, quantity_ordered, quantity_received, unit_cost, created_by)
         VALUES ($1,$2,$3,0,$4,$5)`,
        [poId, l.skuId, l.quantityOrdered, l.unitCost, input.createdBy],
      );
    }
    // Subtotal summed in the database from the lines (NUMERIC, no float).
    const sub = await client.query<{ subtotal: string }>(
      `UPDATE purchase_orders SET subtotal = (
         SELECT COALESCE(SUM(quantity_ordered * unit_cost),0) FROM purchase_order_lines WHERE po_id=$1
       ) WHERE id=$1 RETURNING subtotal`,
      [poId],
    );
    return { id: poId, po_number: po.rows[0]!.po_number, subtotal: sub.rows[0]!.subtotal };
  });
}

export async function getPurchaseOrder(id: string) {
  const po = await pool.query(
    `SELECT id, vendor_id, po_number, status, ordered_at, expected_at, subtotal FROM purchase_orders WHERE id=$1 AND deleted_at IS NULL`,
    [id],
  );
  if (po.rowCount === 0) throw notFound(`purchase order ${id} not found`);
  const lines = await pool.query(
    `SELECT pol.id, pol.sku_id, s.sku_code, pol.quantity_ordered, pol.quantity_received, pol.unit_cost
       FROM purchase_order_lines pol JOIN skus s ON s.id = pol.sku_id
      WHERE pol.po_id=$1 ORDER BY s.sku_code`,
    [id],
  );
  return { ...po.rows[0], lines: lines.rows };
}

async function soleWarehouse(): Promise<string> {
  const wh = await pool.query<{ id: string }>(
    `SELECT id FROM warehouses WHERE active=true AND deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
  );
  if (!wh.rows[0]) throw badRequest('no warehouse to receive into');
  return wh.rows[0].id;
}

export interface ReceivePoInput {
  receipts: { poLineId: string; quantity: number; warehouseId?: string }[];
  createdBy: string | null;
}

// Receive stock against a PO. Writes receipt transactions to the ledger linked
// to the PO, updates quantity_received, and refreshes affected snapshots.
export async function receivePurchaseOrder(poId: string, input: ReceivePoInput) {
  const po = await pool.query<{ status: string }>(
    `SELECT status FROM purchase_orders WHERE id=$1 AND deleted_at IS NULL`,
    [poId],
  );
  if (po.rowCount === 0) throw notFound(`purchase order ${poId} not found`);
  if (po.rows[0]!.status === 'received' || po.rows[0]!.status === 'cancelled') {
    throw conflict(`purchase order is ${po.rows[0]!.status}`);
  }

  const affectedSkus = new Set<string>();
  await withTransaction(async (client) => {
    for (const rcpt of input.receipts) {
      if (!Number.isInteger(rcpt.quantity) || rcpt.quantity <= 0) {
        throw badRequest('receipt quantity must be a positive integer');
      }
      const line = await client.query<{ sku_id: string; unit_cost: string }>(
        `SELECT sku_id, unit_cost FROM purchase_order_lines WHERE id=$1 AND po_id=$2`,
        [rcpt.poLineId, poId],
      );
      if (line.rowCount === 0) throw notFound(`po line ${rcpt.poLineId} not on this PO`);
      const skuId = line.rows[0]!.sku_id;
      const warehouseId = rcpt.warehouseId ?? (await soleWarehouse());

      await client.query(
        `INSERT INTO inventory_transactions
           (sku_id, warehouse_id, txn_type, quantity_delta, unit_cost, reference_type, reference_id, created_by)
         VALUES ($1,$2,'receipt',$3,$4,'purchase_order',$5,$6)`,
        [skuId, warehouseId, rcpt.quantity, line.rows[0]!.unit_cost, poId, input.createdBy],
      );
      await client.query(
        `UPDATE purchase_order_lines SET quantity_received = quantity_received + $2 WHERE id=$1`,
        [rcpt.poLineId, rcpt.quantity],
      );
      affectedSkus.add(skuId);
    }

    // Fully received when every line has met its ordered quantity.
    const remaining = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM purchase_order_lines
        WHERE po_id=$1 AND quantity_received < quantity_ordered`,
      [poId],
    );
    const status = Number(remaining.rows[0]!.n) === 0 ? 'received' : 'partial';
    await client.query(`UPDATE purchase_orders SET status=$2 WHERE id=$1`, [poId, status]);
  });

  for (const skuId of affectedSkus) await refreshSnapshotForSku(skuId);
  return getPurchaseOrder(poId);
}
