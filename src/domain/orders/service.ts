import { randomUUID } from 'node:crypto';
import { withTransaction, pool } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';

// Buyer order intake. Both the online store (via the GHL webhook) and staff
// paper/phone entry land here. Money math stays in Postgres NUMERIC: the order
// subtotal is summed from the generated extended column, never computed as a
// JS float.

export interface OrderLineInput {
  skuId: string;
  quantity: number;
}

export interface CreateOrderInput {
  campaignId: string;
  buyer: {
    ghlContactId: string;
    displayName?: string;
    email?: string;
    phone?: string;
  };
  sellerCode?: string;
  entryChannel: 'online' | 'paper' | 'phone';
  lines: OrderLineInput[];
  orderNumber?: string;
  payment?: {
    amount: string;
    status?: 'pending' | 'authorized' | 'captured' | 'settled' | 'failed' | 'refunded';
    acceptBlueRef?: string;
    ghlTransactionId?: string;
  };
  createdBy: string | null;
}

export async function createOrder(input: CreateOrderInput) {
  if (input.lines.length === 0) throw badRequest('an order needs at least one line');
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw badRequest('each line quantity must be a positive integer');
    }
  }

  // Load the sale and its org. Orders can only be created while the sale is open
  // (the database enforces this too; we check first for a clean 409).
  const camp = await pool.query<{ organization_id: string; status: string }>(
    `SELECT organization_id, status FROM campaigns WHERE id=$1 AND deleted_at IS NULL`,
    [input.campaignId],
  );
  if (camp.rowCount === 0) throw notFound(`sale ${input.campaignId} not found`);
  if (camp.rows[0]!.status !== 'open') {
    throw conflict(`sale is ${camp.rows[0]!.status}; orders can only be entered while open`);
  }
  const organizationId = camp.rows[0]!.organization_id;

  // Effective price per offered SKU: the campaign override, else the SKU price.
  const offered = await pool.query<{ sku_id: string; price: string }>(
    `SELECT cs.sku_id, COALESCE(cs.price_override, s.retail_price) AS price
       FROM campaign_skus cs JOIN skus s ON s.id = cs.sku_id
      WHERE cs.campaign_id=$1`,
    [input.campaignId],
  );
  const priceBySku = new Map(offered.rows.map((r) => [r.sku_id, r.price]));
  for (const l of input.lines) {
    if (!priceBySku.has(l.skuId)) {
      throw badRequest(`SKU ${l.skuId} is not offered in this sale`);
    }
  }

  return withTransaction(async (client) => {
    // Customer upsert. GHL owns identity; we key on ghl_contact_id and keep an
    // operational record that feeds the org list and the master list.
    const customer = await client.query<{ id: string }>(
      `INSERT INTO customers (ghl_contact_id, display_name, email, phone, first_order_at, created_by)
       VALUES ($1,$2,$3,$4, now(), $5)
       ON CONFLICT (ghl_contact_id) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, customers.display_name),
             email = COALESCE(EXCLUDED.email, customers.email),
             phone = COALESCE(EXCLUDED.phone, customers.phone)
       RETURNING id`,
      [
        input.buyer.ghlContactId,
        input.buyer.displayName ?? null,
        input.buyer.email ?? null,
        input.buyer.phone ?? null,
        input.createdBy,
      ],
    );
    const customerId = customer.rows[0]!.id;

    // Roll the customer up to this team, and into the master list by extension.
    await client.query(
      `INSERT INTO organization_customers (organization_id, customer_id, first_order_at, last_order_at, created_by)
       VALUES ($1,$2, now(), now(), $3)
       ON CONFLICT (organization_id, customer_id) DO UPDATE SET last_order_at = now()`,
      [organizationId, customerId, input.createdBy],
    );

    // Seller attribution. The code rides the store link; resolve it within this
    // team. An order with no seller rolls up to the team only.
    let sellerId: string | null = null;
    if (input.sellerCode) {
      const seller = await client.query<{ id: string }>(
        `SELECT id FROM sellers WHERE organization_id=$1 AND seller_code=$2 AND deleted_at IS NULL`,
        [organizationId, input.sellerCode],
      );
      sellerId = seller.rows[0]?.id ?? null;
    }

    const orderNumber = input.orderNumber ?? `ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
    let order;
    try {
      const { rows } = await client.query(
        `INSERT INTO orders
           (campaign_id, order_number, customer_id, seller_id, entry_channel, subtotal, created_by)
         VALUES ($1,$2,$3,$4,$5,0,$6)
         RETURNING id, order_number`,
        [input.campaignId, orderNumber, customerId, sellerId, input.entryChannel, input.createdBy],
      );
      order = rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('order_number already exists');
      throw err;
    }

    for (const l of input.lines) {
      await client.query(
        `INSERT INTO order_lines (order_id, sku_id, quantity, unit_price, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, l.skuId, l.quantity, priceBySku.get(l.skuId), input.createdBy],
      );
    }

    // Subtotal from the generated extended column: NUMERIC all the way, no float.
    const sub = await client.query<{ subtotal: string }>(
      `UPDATE orders SET subtotal = (
         SELECT COALESCE(SUM(extended),0) FROM order_lines WHERE order_id=$1
       ) WHERE id=$1 RETURNING subtotal`,
      [order.id],
    );

    // ACH payment reference. We store a reference and status only; the money
    // moves through GHL and Accept Blue. Never raw bank data.
    let paymentId: string | null = null;
    if (input.payment) {
      const pay = await client.query<{ id: string }>(
        `INSERT INTO payments (order_id, method, amount, status, accept_blue_ref, ghl_transaction_id, created_by)
         VALUES ($1,'ach',$2,$3,$4,$5,$6) RETURNING id`,
        [
          order.id,
          input.payment.amount,
          input.payment.status ?? 'authorized',
          input.payment.acceptBlueRef ?? null,
          input.payment.ghlTransactionId ?? null,
          input.createdBy,
        ],
      );
      paymentId = pay.rows[0]!.id;
    }

    return {
      id: order.id,
      order_number: order.order_number,
      customer_id: customerId,
      seller_id: sellerId,
      subtotal: sub.rows[0]!.subtotal,
      payment_id: paymentId,
    };
  });
}

export async function getOrder(id: string) {
  const order = await pool.query(
    `SELECT id, campaign_id, order_number, customer_id, seller_id, entry_channel, subtotal, status, created_at
       FROM orders WHERE id=$1 AND deleted_at IS NULL`,
    [id],
  );
  if (order.rowCount === 0) throw notFound(`order ${id} not found`);
  const lines = await pool.query(
    `SELECT sku_id, quantity, unit_price, extended FROM order_lines WHERE order_id=$1 ORDER BY created_at`,
    [id],
  );
  return { ...order.rows[0], lines: lines.rows };
}

export async function listOrders(campaignId: string) {
  if (!campaignId) throw badRequest('campaignId is required');
  const { rows } = await pool.query(
    `SELECT id, order_number, customer_id, seller_id, entry_channel, subtotal, status, created_at
       FROM orders WHERE campaign_id=$1 AND deleted_at IS NULL ORDER BY created_at`,
    [campaignId],
  );
  return rows;
}
