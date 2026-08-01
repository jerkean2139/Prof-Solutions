import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import type { GhlJobData, GhlJobName } from '../../queue/ghlQueue.js';

// GoHighLevel v2 API client (services.leadconnectorhq.com). It runs when the
// queue worker hands it a job; nothing calls it synchronously from a request.
//
// Auth: a Bearer token (OAuth access token or Private Integration token) plus
// the Version header. Custom field IDs are per-location and come from config,
// never hardcoded. Endpoints and payloads follow the documented v2 contracts;
// confirm against the account's marketplace docs and a real token before go-live.
//
// The contract requires every call be logged with request, response, and status.
// That happens here, once.

const GHL_API_VERSION = '2021-07-28';

export interface GhlCallResult {
  ok: boolean;
  status: number; // 0 means "not configured, skipped"
  body: unknown;
}

export class GhlClient {
  constructor(
    private readonly apiBase = env.GHL_API_BASE,
    private readonly apiKey = env.GHL_API_KEY,
    private readonly customFieldIds: Record<string, string> = env.GHL_CUSTOM_FIELD_IDS,
  ) {}

  private configured(): boolean {
    return this.apiKey.length > 0;
  }

  async request(method: string, path: string, body?: unknown): Promise<GhlCallResult> {
    const url = `${this.apiBase}${path}`;
    // Without a token we do not pretend to have called GHL. Log the intent and
    // return a skipped result so nothing silently "succeeds".
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
          Version: GHL_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
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
      logger.info({ method, url, status: res.status, ms: Date.now() - started }, 'ghl api call');
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      logger.error(
        { method, url, err: (err as Error).message, ms: Date.now() - started },
        'ghl api call threw',
      );
      throw err;
    }
  }

  // POST /contacts/{contactId}/tags  body: { tags: [...] }
  async addTags(contactId: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const res = await this.request('POST', `/contacts/${contactId}/tags`, { tags });
    if (res.status === 0) return; // not configured
    if (!res.ok) throw new Error(`ghl addTags failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  // PUT /contacts/{contactId}  body: { customFields: [{ id, value }] }
  // Logical field names are mapped to the account's real field IDs. Unmapped
  // fields are skipped with a warning, never guessed.
  async updateContactCustomFields(
    contactId: string,
    fields: Record<string, string | number>,
  ): Promise<void> {
    const customFields: { id: string; value: string | number }[] = [];
    for (const [name, value] of Object.entries(fields)) {
      const id = this.customFieldIds[name];
      if (!id) {
        logger.warn({ field: name }, 'no GHL custom field id mapped; skipping field');
        continue;
      }
      customFields.push({ id, value });
    }
    if (customFields.length === 0) return;
    const res = await this.request('PUT', `/contacts/${contactId}`, { customFields });
    if (res.status === 0) return;
    if (!res.ok) {
      throw new Error(`ghl updateContact failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  // Maps a queued job to the GHL API surface. Every job carries the target
  // contact and, uniformly, the tags to apply and custom fields to write. The
  // message itself is a GHL workflow that fires off these tags, never sent here.
  async handleJob(name: GhlJobName, data: GhlJobData): Promise<void> {
    logger.info({ name, targetId: data.targetId, tags: data.tags }, 'handling ghl job');
    if (data.tags?.length) await this.addTags(data.targetId, data.tags);
    if (data.customFields && Object.keys(data.customFields).length) {
      await this.updateContactCustomFields(data.targetId, data.customFields);
    }
  }
}

export const ghlClient = new GhlClient();
