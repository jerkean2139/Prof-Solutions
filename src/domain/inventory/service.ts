import { pool, withTransaction } from '../../db/pool.js';
import { refreshSnapshotForSku } from '../../inventory/snapshot.js';
import { badRequest, notFound } from '../../http/errors.js';

// The inventory ledger. Rule 1: the ledger is the source of truth, append only.
// Receiving writes a positive receipt row; adjustments write a signed row with a
// reason. Picking (negative) happens through the fulfillment flow, not here.
// After any write we refresh the derived snapshot for that SKU.

async function resolveSkuId(opts: { skuId?: string; qrCode?: string }): Promise<string> {
  if (opts.skuId) {
    const r = await pool.query(`SELECT id FROM skus WHERE id=$1 AND deleted_at IS NULL`, [opts.skuId]);
    if (r.rowCount === 0) throw notFound(`sku ${opts.skuId} not found`);
    return opts.skuId;
  }
  if (opts.qrCode) {
    const r = await pool.query(`SELECT id FROM skus WHERE qr_code=$1 AND deleted_at IS NULL`, [
      opts.qrCode,
    ]);
    if (r.rowCount === 0) throw notFound(`no SKU for QR code ${opts.qrCode}`);
    return r.rows[0].id as string;
  }
  throw badRequest('provide skuId or qrCode');
}

export interface ReceiveInput {
  skuId?: string;
  qrCode?: string;
  warehouseId: string;
  quantity: number;
  unitCost?: string;
  lotCode?: string;
  expiresOn?: string;
  referenceType?: 'purchase_order' | 'manual';
  referenceId?: string;
  createdBy: string | null;
}

// Scan the code, enter quantity, confirm. This is the inbound receiving flow and
// it must be fast: one resolve, one insert, one snapshot refresh.
export async function receiveStock(input: ReceiveInput) {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw badRequest('quantity must be a positive integer');
  }
  const skuId = await resolveSkuId(input);

  const result = await withTransaction(async (client) => {
    let lotId: string | null = null;
    if (input.lotCode) {
      const lot = await client.query(
        `INSERT INTO inventory_lots (sku_id, warehouse_id, lot_code, unit_cost, expires_on, created_by)
         VALUES ($1,$2,$3, COALESCE($4, 0), $5, $6) RETURNING id`,
        [skuId, input.warehouseId, input.lotCode, input.unitCost ?? null, input.expiresOn ?? null, input.createdBy],
      );
      lotId = lot.rows[0].id;
    }
    const txn = await client.query(
      `INSERT INTO inventory_transactions
         (sku_id, warehouse_id, txn_type, quantity_delta, unit_cost, lot_id, reference_type, reference_id, created_by)
       VALUES ($1,$2,'receipt',$3,$4,$5,$6,$7,$8)
       RETURNING id, sku_id, warehouse_id, quantity_delta, created_at`,
      [
        skuId,
        input.warehouseId,
        input.quantity,
        input.unitCost ?? null,
        lotId,
        input.referenceType ?? 'manual',
        input.referenceId ?? null,
        input.createdBy,
      ],
    );
    return txn.rows[0];
  });

  await refreshSnapshotForSku(skuId);
  return result;
}

export interface AdjustInput {
  skuId?: string;
  qrCode?: string;
  warehouseId: string;
  delta: number;
  reason: string;
  createdBy: string | null;
}

// A correction. Requires a reason. Never edits history: it is a new signed row.
export async function adjustStock(input: AdjustInput) {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw badRequest('delta must be a non-zero integer');
  }
  if (!input.reason || !input.reason.trim()) {
    throw badRequest('reason is required for an adjustment');
  }
  const skuId = await resolveSkuId(input);

  const { rows } = await pool.query(
    `INSERT INTO inventory_transactions
       (sku_id, warehouse_id, txn_type, quantity_delta, reason, reference_type, created_by)
     VALUES ($1,$2,'adjustment',$3,$4,'manual',$5)
     RETURNING id, sku_id, warehouse_id, quantity_delta, reason, created_at`,
    [skuId, input.warehouseId, input.delta, input.reason.trim(), input.createdBy],
  );
  await refreshSnapshotForSku(skuId);
  return rows[0];
}

// On-hand read comes from the snapshot cache. Reports that answer "can we
// fulfill this" must use available (on_hand minus committed), which the snapshot
// exposes as a generated column.
export async function getOnHand(skuId: string) {
  const { rows } = await pool.query(
    `SELECT sku_id, warehouse_id, quantity_on_hand, quantity_committed, quantity_available, last_computed_at
       FROM inventory_snapshots WHERE sku_id=$1
      ORDER BY warehouse_id`,
    [skuId],
  );
  return rows;
}
