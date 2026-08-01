import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';

// ACH runs through GoHighLevel's Accept Blue integration. The custom stack is
// not in the money-movement path and is not in PCI or NACHA scope. Rule 7: we
// store a payment reference and status only, never raw account or routing data.
// There is no code path in this file that accepts a bank number, by design.

export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'settled'
  | 'failed'
  | 'refunded';

export interface PaymentReference {
  orderId: string;
  amount: string; // NUMERIC(12,2) as string, never a float
  status: PaymentStatus;
  acceptBlueRef?: string;
  ghlTransactionId?: string;
}

// Verify an inbound Accept Blue / GHL webhook signature before trusting it.
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!env.ACCEPT_BLUE_WEBHOOK_SECRET) {
    logger.warn('ACCEPT_BLUE_WEBHOOK_SECRET not set; rejecting webhook');
    return false;
  }
  const expected = createHmac('sha256', env.ACCEPT_BLUE_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Record or update a payment reference. Status changes are new writes, never
// deletes. A refund or failure updates the row, it never removes the order.
export async function upsertPaymentReference(ref: PaymentReference): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payments (order_id, method, amount, status, accept_blue_ref, ghl_transaction_id)
     VALUES ($1, 'ach', $2, $3, $4, $5)
     RETURNING id`,
    [ref.orderId, ref.amount, ref.status, ref.acceptBlueRef ?? null, ref.ghlTransactionId ?? null],
  );
  const id = rows[0]!.id;
  logger.info({ paymentId: id, orderId: ref.orderId, status: ref.status }, 'payment reference recorded');
  return id;
}

export async function updatePaymentStatus(
  paymentId: string,
  status: PaymentStatus,
): Promise<void> {
  await pool.query(`UPDATE payments SET status = $2 WHERE id = $1`, [paymentId, status]);
  logger.info({ paymentId, status }, 'payment status updated');
}
