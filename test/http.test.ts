import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createServer } from '../src/http/server.js';
import { ensureMigrated } from './helpers.js';

// Exercises the Express layer itself -- route mounting, the mock auth boundary,
// webhook intake, and the central error handler -- which the service-level tests
// never touch. Boots the real app on an ephemeral port and speaks HTTP to it.

let server: Server;
let base: string;

// fetch().json() is typed unknown; a tiny helper keeps the assertions readable.
async function getJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeAll(async () => {
  await ensureMigrated();
  server = createServer().listen(0);
  await new Promise<void>((res) => server.once('listening', () => res()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('HTTP layer', () => {
  it('health check reports the db is up', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const body = await getJson<{ ok: boolean; db: string }>(r);
    expect(body).toMatchObject({ ok: true, db: 'up' });
  });

  it('injects the mock identity on a guarded route while enforcement is off', async () => {
    const r = await fetch(`${base}/me`);
    expect(r.status).toBe(200);
    const body = await getJson<{ auth: { source: string } }>(r);
    expect(body.auth.source).toBe('mock');
  });

  it('serves warehouse and schema reads', async () => {
    const wh = await fetch(`${base}/warehouses`);
    expect(wh.status).toBe(200);
    expect(Array.isArray(await getJson<unknown[]>(wh))).toBe(true);

    const schema = await fetch(`${base}/agent/schema`);
    expect(schema.status).toBe(200);
    const { tables } = await getJson<{ tables: { table: string }[] }>(schema);
    expect(tables.some((t: { table: string }) => t.table === 'orders')).toBe(true);
  });

  it('returns the dashboard summary shape', async () => {
    const r = await fetch(`${base}/dashboard/summary`);
    expect(r.status).toBe(200);
    const body = await getJson<{ headline: Record<string, unknown> }>(r);
    expect(body.headline).toHaveProperty('revenue');
    expect(body).toHaveProperty('pipeline');
  });

  it('reports the ops agent as not configured (503) and validates input (400)', async () => {
    const ok = await fetch(`${base}/agent/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'how many orders?' }),
    });
    expect(ok.status).toBe(503);
    expect((await getJson<{ code: string }>(ok)).code).toBe('agent_not_configured');

    const bad = await fetch(`${base}/agent/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });

  it('acknowledges an unknown GHL webhook type', async () => {
    const r = await fetch(`${base}/webhooks/ghl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'contact.updated' }),
    });
    expect(r.status).toBe(200);
    expect(await getJson(r)).toEqual({ received: true });
  });

  it('rejects an Accept Blue webhook with no valid signature', async () => {
    const r = await fetch(`${base}/webhooks/accept-blue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment' }),
    });
    expect(r.status).toBe(401);
  });

  it('maps malformed JSON to a 400, not a 500', async () => {
    const r = await fetch(`${base}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    });
    expect(r.status).toBe(400);
  });
});
