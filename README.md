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

## HTTP surface (Phase 0)

- `GET /health` — liveness plus a DB check
- `GET /me` — returns the auth context (mock identity until Clerk is enforced)
- `POST /webhooks/accept-blue` — verifies the signature, then records payment refs
- `POST /webhooks/ghl` — inbound store/contact events (handlers land in Phase 1)

## Testing notes

The suite runs against a real Postgres and Redis (it does not mock the
database, because the database is where the integrity lives). Point
`DATABASE_URL` and `REDIS_URL` at throwaway instances. The tests share one
database and run serially.
