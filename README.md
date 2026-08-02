# Profitable Solutions Operating System

Operational backbone for team-based fundraising with held stock and bulk
delivery. GoHighLevel is the front door (storefronts, messaging, ACH payments,
contact identity). This application is the operational engine behind it:
products, inventory, sales, orders, fulfillment, and commissions.

Start with the docs, in this order:

- `CLAUDE.md` — the model, the hard GHL boundary, phase scope, non-negotiable rules
- `DECISIONS.md` — confirmed decisions with reasoning
- `BUSINESS-RULES.md` — the logic the code enforces
- `INTEGRATION-CONTRACT.md` — who owns which field, and the sync rules
- `SCHEMA.md` — the data model
- `BUILD-PLAN.md` — phases and what "done" means for each
- `RUNBOOK.md` — how to run, deploy, smoke-test, and turn on the key-gated pieces

## Stack

TypeScript on Node 20+, Postgres, Redis, Express. Plain SQL migrations run by a
small in-repo runner (no ORM): the database has to outlive the application, so
migrations are portable SQL. Clerk is the auth boundary, wired now and enforced
later. Deploys target Railway.

## Phase 0 (this repo today)

Foundation only, no end-user UI:

- Reversible SQL migrations for the full schema, with the integrity rules in the
  database: append-only `inventory_transactions`, orders gated on an open sale,
  money as `NUMERIC(12,2)`, generated line and availability columns.
- A mock-data seed that runs the whole money-in loop once (team, sellers,
  buyers, a sale with ACH payment references, then a finalize that commits
  inventory).
- The GoHighLevel outbound queue (Redis/BullMQ) with retry, exponential backoff,
  and a dead-letter queue. Nothing calls GHL synchronously.
- The Accept Blue payment-reference model and webhook intake. Stores a reference
  and status only, never raw bank credentials.
- Clerk wired into the app boundary, enforcement off.
- An inventory snapshot rebuild that regenerates the derived cache from the
  ledger and produces identical numbers every run.

## Prerequisites

- Node 20+
- A Postgres 14+ database
- A Redis 6+ instance

## Setup

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL and REDIS_URL at minimum
npm run migrate:up        # apply all migrations
npm run seed              # load mock data (refuses to run in production)
```

## Commands

```bash
npm run migrate:up        # apply pending migrations
npm run migrate:down      # roll back the most recent migration
npm run migrate:status    # show applied / pending
npm run migrate:reset     # roll everything back (dev only)
npm run seed              # wipe and load mock data (dev/test only)
npm run snapshot:rebuild  # rebuild inventory snapshots from the ledger
npm run dev               # run the HTTP server with reload
npm run typecheck         # tsc --noEmit
npm test                  # vitest: migrations, DB guards, snapshot, seed, queue
```

## HTTP surface

- `GET /health` — liveness plus a DB check
- `GET /me` — returns the auth context (mock identity until Clerk is enforced)
- `POST /webhooks/accept-blue` — verifies the signature, then records payment refs
- `POST /webhooks/ghl` — inbound store/contact events (online orders)
- Operational JSON API: products, inventory (receive/adjust/on-hand/warehouses),
  organizations (with customer base), sales (create/open/finalize), orders,
  fulfillment (pick list generate/read/pick/ship/packing slip), settlement +
  commissions, reports (margin, leaderboard), vendors + purchase orders,
  forecasting + reorder, and the owner dashboard summary.
- Read-only ops agent (Phase 3): `GET /agent/schema` and `POST /agent/query`.

## The PWA

An installable Progressive Web App is served by the same server at `/app` (no
separate build or deploy). Open `/app/` in a browser or install it to the home
screen. Its views:

- **Order entry** — keyboard-first paper/phone order capture: pick an open sale,
  type the SKU code and quantity, Enter to add, live running total, save and
  immediately start the next order.
- **Sales** — start a sale for a team: choose the products it offers (with
  optional per-SKU price overrides), create it, and open it so it appears in
  Order entry. Lists sales with status and opens drafts.
- **Receiving** — inbound stock: scan a QR/barcode with the phone camera (native
  `BarcodeDetector`, with a manual code fallback for browsers without it) or type
  the code, enter quantity, confirm. Writes a receipt to the ledger and shows the
  new on-hand. Built to beat the spreadsheet on speed.
- **Fulfillment** — drives a sale end to end: finalize (with next-sale target and
  incentive), generate the bulk pick list, pick each line, ship one delivery.
- **Team portal** — order history, the team's customer base, the seller
  leaderboard, and the next-sale countdown.
- **Dashboard** — the owner's read-only rollup: revenue, gross margin, units,
  active teams, the sales pipeline, inventory health, reorder alerts, and top
  sellers.
- **Catalog** — set up the products and SKUs (with QR codes) the receiving
  screen scans against. A SKU added here is immediately scannable in Receiving.
- **Purchasing** — add vendors, raise purchase orders, and receive stock against
  them. Receiving a PO writes to the same append-only ledger as the receiving
  screen, closing the loop from forecast to reorder to PO to on-hand.
- **Payouts** — the commission run: accrued to approved to paid, one action per
  row so the lifecycle is enforced in the UI as well as the API.

The Fulfillment view also carries settlement: once a sale is delivered it shows
the packing slip and a settle step that computes the reconciled payout breakdown
and accrues commissions for the Payouts run.

The PWA calls the same-origin API. While Clerk enforcement is off it uses the
mock identity; when enforcement flips on it will attach a Clerk session.

## Enabling Clerk enforcement

Auth is wired and enforced later (rule 9). The boundary (`requireAuth`) injects a
mock identity while `AUTH_ENFORCED=false` and requires a valid Clerk bearer token
when it is `true`. To turn it on:

1. Set `CLERK_SECRET_KEY` (and `CLERK_PUBLISHABLE_KEY` for the frontend).
2. Provision internal staff in the `users` table with their `clerk_user_id` so
   `created_by` resolves; organizations carry `clerk_org_id` for portal access.
3. Set `AUTH_ENFORCED=true` and restart. The app refuses to start with
   enforcement on and no secret key, so a misconfiguration fails fast.

The enforced path (missing token, invalid token, valid token) is covered by
tests using an injected verifier, so no real keys are needed to verify the logic.

## Read-only ops agent (Phase 3)

The ops agent answers natural-language questions by running a single SELECT
against the database. It never writes anything (rule 10), enforced in three
layers so no one layer stands alone:

1. A SQL guard rejects anything that is not one read-only SELECT/WITH, strips
   comments, and blocks write/DDL keywords and dangerous functions.
2. A dedicated `profsol_readonly` Postgres role holds SELECT and nothing else
   (migration `0011`).
3. Every query runs inside a `READ ONLY` transaction under that role, so the
   database itself refuses any write even if the guard were bypassed.

The piece that turns a question into SQL — the planner — is an injectable seam,
exactly like the Clerk verifier. The whole pipeline (schema context, guard,
read-only execution) is built and tested with an injected planner and no key.
Wiring the default planner to a model needs `ANTHROPIC_API_KEY` plus a live
verification pass; until then `POST /agent/query` reports that it is not
configured rather than fabricating SQL. `GET /agent/schema` (metadata only,
never data) works today.

## GoHighLevel integration

See `GHL-SETUP.md` for the full from-scratch setup. The outbound worker
(`npm run worker`) sends tags and custom fields to GHL; without `GHL_API_KEY`
it logs and skips.

## Testing notes

The suite runs against a real Postgres and Redis (it does not mock the
database, because the database is where the integrity lives). Point
`DATABASE_URL` and `REDIS_URL` at throwaway instances. The tests share one
database and run serially.
