/**
 * GHL preflight: verify the GoHighLevel setup before trusting it with a sale.
 *
 * Run it after following GHL-GO-LIVE.md:
 *
 *   npm run ghl:preflight
 *
 * It answers one question — "is the GHL wiring actually correct?" — instead of
 * letting a wrong field ID surface later as a silently skipped custom field on
 * a real team's finalize.
 *
 * Deliberately standalone: it reads the environment itself rather than
 * importing src/config/env.ts, because that module also requires DATABASE_URL
 * and REDIS_URL. A GHL setup check that fails on a missing Redis URL would be
 * useless at exactly the moment you need it. It never writes to GHL, and it
 * never prints the token.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const API_BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const API_KEY = process.env.GHL_API_KEY || '';
const LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const RAW_FIELD_IDS = process.env.GHL_CUSTOM_FIELD_IDS || '{}';
const GHL_API_VERSION = '2021-07-28';

// The logical field names the application actually writes. Kept in step with
// the emitGhlEvent call sites; if you add a custom field to an outbound event,
// add it here too or preflight will not check it.
const REQUIRED_FIELDS: { name: string; label: string; type: string; writtenWhen: string }[] = [
  { name: 'sale_total_raised', label: 'Sale Total Raised', type: 'Monetary or Number', writtenWhen: 'a sale is finalized' },
  { name: 'sale_unit_count', label: 'Sale Unit Count', type: 'Number', writtenWhen: 'a sale is finalized' },
  { name: 'next_sale_target', label: 'Next Sale Target', type: 'Date', writtenWhen: 'a finalize sets a next-sale target' },
  { name: 'incentive', label: 'Incentive', type: 'Text', writtenWhen: 'a finalize sets a next-sale target' },
  { name: 'tracking_number', label: 'Tracking Number', type: 'Text', writtenWhen: 'a bulk shipment is recorded' },
  { name: 'carrier', label: 'Carrier', type: 'Text', writtenWhen: 'a bulk shipment is recorded' },
];

// Tags cannot be verified through the API: GHL creates a tag the moment it is
// applied, so "does this tag exist" is not a meaningful question. What matters
// is that a workflow is listening for each one, which only a human can confirm.
const TRIGGER_TAGS = ['team-onboarded', 'sale-complete', 'next-sale-eligible', 'shipment-sent'];

type Status = 'pass' | 'fail' | 'warn' | 'skip';

const results: { status: Status; label: string; detail?: string }[] = [];
let liveChecksRan = false;

function record(status: Status, label: string, detail?: string): void {
  results.push({ status, label, detail });
  const mark = { pass: '  OK  ', fail: ' FAIL ', warn: ' WARN ', skip: ' SKIP ' }[status];
  console.log(`[${mark}] ${label}`);
  if (detail) for (const line of detail.split('\n')) console.log(`         ${line}`);
}

async function ghlGet(
  path: string,
): Promise<{ ok: boolean; status: number; body: unknown; isJson: boolean; contentType: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Version: GHL_API_VERSION,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let body: unknown = text;
  let isJson = false;
  try {
    body = text ? JSON.parse(text) : null;
    isJson = true;
  } catch {
    // Leave as text; the caller reports the shape it got.
  }
  return {
    ok: res.ok,
    status: res.status,
    body,
    isJson,
    contentType: res.headers.get('content-type') ?? '',
  };
}

// A corporate proxy, VPN, or egress filter between here and GHL also answers
// 401/403 — and telling someone their token is bad when the request never left
// the building sends them to re-issue a perfectly good token. The GHL API
// always answers in JSON, so a non-JSON denial did not come from GHL.
function deniedBeforeReachingGhl(res: { isJson: boolean; contentType: string }): boolean {
  return !res.isJson && !res.contentType.includes('json');
}

// GHL has moved this payload's shape around between revisions, so accept the
// documented wrapper or a bare array rather than failing on a shape change.
function extractCustomFields(body: unknown): { id: string; name?: string; dataType?: string }[] | null {
  if (Array.isArray(body)) return body as { id: string }[];
  if (body && typeof body === 'object') {
    const wrapped = (body as Record<string, unknown>).customFields;
    if (Array.isArray(wrapped)) return wrapped as { id: string }[];
  }
  return null;
}

function checkConfig(): Record<string, string> | null {
  if (API_KEY) {
    record('pass', 'GHL_API_KEY is set', `token length ${API_KEY.length} (value never printed)`);
  } else {
    record(
      'fail',
      'GHL_API_KEY is empty',
      'Without it the app logs outbound calls and skips them, so nothing reaches GHL.\nCreate a Private Integration token: GHL-GO-LIVE.md step 1.',
    );
  }

  if (LOCATION_ID) {
    record('pass', 'GHL_LOCATION_ID is set', LOCATION_ID);
  } else {
    record('fail', 'GHL_LOCATION_ID is empty', 'Get it from the location URL: GHL-GO-LIVE.md step 2.');
  }

  let fieldIds: Record<string, string>;
  try {
    const parsed = JSON.parse(RAW_FIELD_IDS) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      record('fail', 'GHL_CUSTOM_FIELD_IDS is not a JSON object', `got: ${RAW_FIELD_IDS.slice(0, 80)}`);
      return null;
    }
    fieldIds = parsed as Record<string, string>;
    record('pass', 'GHL_CUSTOM_FIELD_IDS is valid JSON');
  } catch {
    record(
      'fail',
      'GHL_CUSTOM_FIELD_IDS is not valid JSON',
      `got: ${RAW_FIELD_IDS.slice(0, 80)}\nIt must be a single-line JSON object of logical name to GHL field ID.`,
    );
    return null;
  }

  const missing = REQUIRED_FIELDS.filter((f) => !fieldIds[f.name]);
  if (missing.length === 0) {
    record('pass', `all ${REQUIRED_FIELDS.length} required custom fields are mapped`);
  } else {
    record(
      'fail',
      `${missing.length} required custom field(s) not mapped`,
      missing.map((f) => `${f.name}  (${f.label}, ${f.type}) — written when ${f.writtenWhen}`).join('\n') +
        '\nAn unmapped field is skipped at runtime with a warning, never guessed.',
    );
  }

  // A name the app never writes is almost always a typo in a name it does.
  const known = new Set(REQUIRED_FIELDS.map((f) => f.name));
  const unknown = Object.keys(fieldIds).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    record(
      'warn',
      `${unknown.length} mapped name(s) the app never writes`,
      `${unknown.join(', ')}\nHarmless, but check for a typo in one of: ${[...known].join(', ')}`,
    );
  }

  // The same ID under two names means a copy-paste slip, and one of the two
  // fields will be written with the other's value.
  const byId = new Map<string, string[]>();
  for (const [name, id] of Object.entries(fieldIds)) {
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), name]);
  }
  const dupes = [...byId.entries()].filter(([, names]) => names.length > 1);
  if (dupes.length > 0) {
    record(
      'fail',
      'the same field ID is mapped to more than one name',
      dupes.map(([id, names]) => `${id} <- ${names.join(', ')}`).join('\n') +
        '\nOne of these will be written with the other field\'s value.',
    );
  }

  return fieldIds;
}

async function checkLive(fieldIds: Record<string, string>): Promise<void> {
  if (!API_KEY || !LOCATION_ID) {
    record('skip', 'live checks against GHL', 'needs both GHL_API_KEY and GHL_LOCATION_ID');
    return;
  }
  liveChecksRan = true;

  let location: Awaited<ReturnType<typeof ghlGet>>;
  try {
    location = await ghlGet(`/locations/${LOCATION_ID}`);
  } catch (err) {
    record('fail', 'could not reach GHL', `${(err as Error).message}\nChecked ${API_BASE}`);
    return;
  }

  if ((location.status === 401 || location.status === 403) && deniedBeforeReachingGhl(location)) {
    record(
      'fail',
      `blocked before reaching GHL (HTTP ${location.status}, ${location.contentType || 'no content-type'})`,
      `The denial did not come from GHL — its API always answers in JSON.\n` +
        `Something between here and ${API_BASE} refused the request: a proxy, VPN, or egress filter.\n` +
        'Your token is not implicated. Retry from a network that can reach GHL.',
    );
    return;
  }
  if (location.status === 401 || location.status === 403) {
    record(
      'fail',
      `token rejected by GHL (HTTP ${location.status})`,
      'The token is wrong, expired, or lacks scope for this location.\nRe-issue it and confirm the scopes in GHL-GO-LIVE.md step 1.',
    );
    return;
  }
  if (location.status === 404) {
    record(
      'fail',
      'location not found (HTTP 404)',
      `GHL_LOCATION_ID=${LOCATION_ID}\nThe token authenticated but this location does not exist under it.`,
    );
    return;
  }
  if (!location.ok) {
    record('fail', `unexpected response fetching the location (HTTP ${location.status})`, JSON.stringify(location.body).slice(0, 300));
    return;
  }

  const locName =
    (location.body as { location?: { name?: string }; name?: string })?.location?.name ??
    (location.body as { name?: string })?.name;
  record('pass', 'token authenticates and the location resolves', locName ? `location: ${locName}` : undefined);

  const cf = await ghlGet(`/locations/${LOCATION_ID}/customFields`);
  if (!cf.ok) {
    record(
      'warn',
      `could not list custom fields (HTTP ${cf.status})`,
      'Field IDs could not be verified against the account. The mapping may still be correct.\n' +
        JSON.stringify(cf.body).slice(0, 300),
    );
    return;
  }

  const live = extractCustomFields(cf.body);
  if (!live) {
    record(
      'warn',
      'custom fields response was not in a recognised shape',
      'Field IDs could not be verified. This usually means GHL changed the payload shape.\n' +
        JSON.stringify(cf.body).slice(0, 300),
    );
    return;
  }

  const liveById = new Map(live.map((f) => [f.id, f]));
  const bad: string[] = [];
  const good: string[] = [];
  for (const f of REQUIRED_FIELDS) {
    const id = fieldIds[f.name];
    if (!id) continue; // already reported by checkConfig
    const hit = liveById.get(id);
    if (hit) {
      good.push(`${f.name} -> "${hit.name ?? '(unnamed)'}"${hit.dataType ? ` [${hit.dataType}]` : ''}`);
    } else {
      bad.push(`${f.name} -> ${id}  (no field with this ID in the location)`);
    }
  }

  if (good.length > 0) {
    record('pass', `${good.length} field ID(s) verified against the location`, good.join('\n'));
  }
  if (bad.length > 0) {
    record(
      'fail',
      `${bad.length} field ID(s) do not exist in this location`,
      bad.join('\n') + `\nThe location has ${live.length} custom field(s). Re-copy the IDs: GHL-GO-LIVE.md step 4.`,
    );
  }
}

async function main(): Promise<void> {
  console.log('\nGHL preflight');
  console.log(`API base: ${API_BASE}\n`);

  const fieldIds = checkConfig();
  console.log('');
  if (fieldIds) await checkLive(fieldIds);

  console.log('\nTrigger tags the app applies (verify by eye in GHL — tags cannot be checked by API):');
  for (const t of TRIGGER_TAGS) console.log(`  - ${t}`);
  console.log('  Each needs a workflow listening for it, or the message never goes out.');

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  console.log('\n' + '-'.repeat(60));
  if (failed > 0) {
    console.log(`FAIL — ${failed} problem(s)${warned ? `, ${warned} warning(s)` : ''}. GHL is not ready.`);
    process.exit(1);
  }
  if (!liveChecksRan) {
    console.log(`Config looks right, but nothing was checked against GHL${warned ? ` (${warned} warning(s))` : ''}.`);
    process.exit(1);
  }
  console.log(`PASS — GHL config verified against the live location${warned ? `, ${warned} warning(s) to glance at` : ''}.`);
  console.log('Next: run the worker (npm run worker) and do the end-to-end test in GHL-GO-LIVE.md step 6.');
}

main().catch((err) => {
  console.error('\npreflight crashed:', (err as Error).message);
  process.exit(1);
});
