import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { GhlJobData, GhlJobName } from '../../queue/ghlQueue.js';

// A thin GoHighLevel API client. It does the actual HTTP work when the queue
// worker hands it a job. It is never called synchronously from a request path.
//
// The contract requires every call be logged with request, response, and
// status. That happens here, once, so no caller has to remember to do it.

export interface GhlCallResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export class GhlClient {
  constructor(
    private readonly apiBase = env.GHL_API_BASE,
    private readonly apiKey = env.GHL_API_KEY,
  ) {}

  private configured(): boolean {
    return this.apiKey.length > 0;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GhlCallResult> {
    const url = `${this.apiBase}${path}`;
    // Phase 0: without a key we do not pretend to have called GHL. We log the
    // intent and return a not-configured result so nothing silently "succeeds".
    if (!this.configured()) {
      logger.warn({ method, url }, 'ghl not configured; skipping outbound call');
      return { ok: false, status: 0, body: { skipped: 'ghl_not_configured' } };
    }

    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // leave as text
      }
      logger.info(
        { method, url, status: res.status, ms: Date.now() - started },
        'ghl api call',
      );
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      logger.error(
        { method, url, err: (err as Error).message, ms: Date.now() - started },
        'ghl api call threw',
      );
      throw err;
    }
  }

  // Maps a queued job to the GHL API surface. Phase 1 fills in the real
  // endpoints. Phase 0 defines the shape and the logging path.
  async handleJob(name: GhlJobName, data: GhlJobData): Promise<void> {
    logger.info({ name, targetId: data.targetId, tags: data.tags }, 'handling ghl job');
    switch (name) {
      case 'sale.finalized':
      case 'growth.next_sale':
      case 'store.provision':
      case 'rep.approved':
      case 'seller.approved':
      case 'territory.assigned':
      case 'shipment.sent':
      case 'commission.updated':
        // Real endpoint wiring lands in Phase 1. Placeholder call keeps the
        // logging and error path exercised end to end.
        await this.request('POST', `/contacts/${data.targetId}/tags`, {
          tags: data.tags ?? [],
        });
        return;
      default: {
        const exhaustive: never = name;
        throw new Error(`Unhandled GHL job: ${String(exhaustive)}`);
      }
    }
  }
}

export const ghlClient = new GhlClient();
