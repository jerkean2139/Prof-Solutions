import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GhlClient } from '../src/integrations/ghl/client.js';

// Proves the exact requests the client sends, with a mocked fetch. No live GHL.

function mockFetch(status = 200, body: unknown = {}) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

const FIELD_MAP = { sale_total_raised: 'F1', sale_unit_count: 'F2' };

describe('GhlClient', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('adds tags with the correct method, url, headers, and body', async () => {
    const f = mockFetch(200, { tags: ['sale-complete'] });
    globalThis.fetch = f;
    const client = new GhlClient('https://ghl.test', 'token-123', FIELD_MAP);

    await client.addTags('C1', ['sale-complete']);

    expect(f).toHaveBeenCalledTimes(1);
    const [url, opts] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://ghl.test/contacts/C1/tags');
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-123');
    expect(headers.Version).toBe('2021-07-28');
    expect(JSON.parse(opts.body as string)).toEqual({ tags: ['sale-complete'] });
  });

  it('maps logical custom field names to account field IDs on update', async () => {
    const f = mockFetch(200, {});
    globalThis.fetch = f;
    const client = new GhlClient('https://ghl.test', 'token-123', FIELD_MAP);

    await client.updateContactCustomFields('C1', { sale_total_raised: '135.00', sale_unit_count: 5 });

    const [url, opts] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://ghl.test/contacts/C1');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body as string)).toEqual({
      customFields: [
        { id: 'F1', value: '135.00' },
        { id: 'F2', value: 5 },
      ],
    });
  });

  it('skips unmapped custom fields instead of inventing an id', async () => {
    const f = mockFetch(200, {});
    globalThis.fetch = f;
    const client = new GhlClient('https://ghl.test', 'token-123', FIELD_MAP);

    await client.updateContactCustomFields('C1', { unknown_field: 'x' });
    // Nothing mapped -> no request at all.
    expect(f).not.toHaveBeenCalled();
  });

  it('handleJob applies tags and custom fields for a finalized sale', async () => {
    const f = mockFetch(200, {});
    globalThis.fetch = f;
    const client = new GhlClient('https://ghl.test', 'token-123', FIELD_MAP);

    await client.handleJob('sale.finalized', {
      targetId: 'C9',
      tags: ['sale-complete'],
      customFields: { sale_total_raised: '90.00', sale_unit_count: 2 },
    });

    expect(f).toHaveBeenCalledTimes(2); // tags POST + custom fields PUT
    const urls = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.map(
      (c) => c[0],
    );
    expect(urls).toContain('https://ghl.test/contacts/C9/tags');
    expect(urls).toContain('https://ghl.test/contacts/C9');
  });

  it('does not call out when no token is configured (no throw, no fetch)', async () => {
    const f = mockFetch(200, {});
    globalThis.fetch = f;
    const client = new GhlClient('https://ghl.test', '', FIELD_MAP);

    await expect(client.addTags('C1', ['x'])).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response so the queue retries', async () => {
    const f = mockFetch(400, { error: 'bad' });
    globalThis.fetch = f;
    const client = new GhlClient('https://ghl.test', 'token-123', FIELD_MAP);

    await expect(client.addTags('C1', ['x'])).rejects.toThrow(/addTags failed: 400/);
  });
});
