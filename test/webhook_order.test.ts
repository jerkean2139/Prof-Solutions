import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { pool } from '../src/db/pool.js';
import { createServer } from '../src/http/server.js';
import { ensureMigrated, wipeDomain } from './helpers.js';
import { registerTeam } from '../src/domain/organizations/service.js';
import { createProduct, createSku } from '../src/domain/products/service.js';
import { createSale, openSale } from '../src/domain/sales/service.js';
import { listOrders } from '../src/domain/orders/service.js';

// The most business-critical integration: a buyer orders on the GoHighLevel
// store, which posts order.created to /webhooks/ghl, and the custom stack turns
// it into an order on the open sale. This exercises that path through the real
// HTTP handler, not the service function directly.

let server: Server;
let base: string;
let saleId: string;
let skuId: string;

beforeAll(async () => {
  await ensureMigrated();
  await wipeDomain();
  await pool.query(
    `INSERT INTO commission_plans (name, effective_from, active) VALUES ('Default','2026-01-01',true)`,
  );
  const org = await registerTeam({
    name: 'Team',
    orgType: 'school',
    ghlContactId: 'ghl-org-1',
    storeSlug: 'team',
    agreement: { termsVersion: 'v1', termsSnapshot: 't', acceptedBy: 'Coach' },
    createdBy: null,
  });
  const product = await createProduct({
    name: 'Candle',
    brand: 'PS',
    category: 'candle',
    ownerEntity: 'profitable_solutions',
    createdBy: null,
  });
  const sku = await createSku({ productId: product.id, skuCode: 'CAN', createdBy: null });
  skuId = sku.id;
  const sale = await createSale({
    organizationId: org.id,
    name: 'Sale',
    skus: [{ skuId }],
    createdBy: null,
  });
  saleId = sale.id;
  await openSale(saleId);

  server = createServer().listen(0);
  await new Promise<void>((res) => server.once('listening', () => res()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('GHL online-order webhook', () => {
  it('turns an order.created event into an order on the open sale', async () => {
    const r = await fetch(`${base}/webhooks/ghl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'order.created',
        order: {
          campaignId: saleId,
          buyer: { ghlContactId: 'ghl-buyer-1', displayName: 'Online Buyer' },
          lines: [{ skuId, quantity: 2 }],
        },
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { received: boolean; orderId: string };
    expect(body.received).toBe(true);
    expect(body.orderId).toBeTruthy();

    // The order really exists on the sale, and it is marked as an online order.
    const orders = await listOrders(saleId);
    const mine = orders.find((o: { id: string }) => o.id === body.orderId);
    expect(mine).toBeDefined();
    expect(mine.entry_channel).toBe('online');
  });

  it('rejects a malformed order.created with a 400', async () => {
    const r = await fetch(`${base}/webhooks/ghl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'order.created',
        order: { campaignId: saleId, buyer: {}, lines: [] }, // no lines
      }),
    });
    expect(r.status).toBe(400);
  });
});
