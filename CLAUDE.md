# CLAUDE.md — Profitable Solutions Operating System

## What this is

A custom operational backbone for a fundraising products company doing roughly $6.5M a year. They currently run on Excel and legal pads. There is no ERP, no inventory software, no existing system to integrate with or migrate from.

GoHighLevel is already the CRM and marketing hub. This application does not replace it. It extends it.

## Stack

- Claude Code for the build
- Railway for hosting
- Postgres for primary data
- Redis for caching and job queues
- GoHighLevel API for CRM sync

## The hard boundary

Read this before writing any code.

**GoHighLevel owns:**
- Contact and rep identity (name, email, phone, address)
- Rep application pipeline and onboarding sequences
- All customer-facing funnels and landing pages
- SMS, email, conversations
- Marketing campaigns, retargeting, pixels

**This application owns:**
- Products and SKUs
- Fundraising campaigns and their orders
- Inventory (the ledger, the counts, the lots)
- Pick lists, packing slips, shipments
- Commission calculation and settlement
- Vendor purchase orders
- Reporting and dashboards

**Never duplicate a GHL capability here.** If a feature already exists in GoHighLevel, use the API. When in doubt, ask before building it.

See `INTEGRATION-CONTRACT.md` for the exact sync rules.

## Phase scope

### Phase 1 (build this, nothing else)
1. Products and SKUs with QR/barcode resolution
2. Inventory ledger with receipt, pick, and adjustment transactions
3. Phone-based QR scanning for inbound receiving
4. Campaigns and order entry (including bulk paper order entry)
5. Pick list generation
6. Packing slips

**Phase 1 is done when** a warehouse worker can receive stock by scanning a code on their phone, staff can enter a stack of paper orders for a campaign, the system generates an accurate pick list, and inventory reflects reality without anyone touching a spreadsheet.

### Phase 2 (do not start until Phase 1 is in production)
- Vendor management and purchase orders
- Commission settlement and payout ledger
- Cost analysis reporting
- Accounting integration
- Territory management

### Phase 3
- Read-only ops AI agent (natural language queries against the database)
- Front-end web AI agent
- Owner dashboard

## Non-negotiable rules

1. **Inventory transactions are append-only.** Never UPDATE or DELETE a row in `inventory_transactions`. Corrections are new offsetting rows. On-hand quantity is derived from the ledger, cached for speed, never authoritative on its own.

2. **Money is `NUMERIC(12,2)`.** Never float, never double precision. Not once.

3. **Commission values live in config tables, never in code.** The distributor rate is still undecided (10% or 15%). If a rate is hardcoded anywhere, that is a bug.

4. **The $45 unit price is a default, not a constant.** It is the business anchor today. Model it as a per-SKU value with campaign-level override.

5. **Every table gets `created_at`, `updated_at`, `created_by`.** This business will eventually be audited. Assume it.

6. **Soft delete only.** Use `deleted_at`. Nothing gets hard deleted.

7. **The AI agent gets a read-only Postgres role in Phase 3.** It never writes inventory. Not even a little.

8. **Every schema migration is reversible and checked in.** No manual database changes, ever.

## Working agreement

- Feature branch to PR. Never push to main.
- State your assumptions before writing code, not after.
- Green tests are not a working feature. Deploy plus smoke test before calling anything done.
- If a requirement is ambiguous, make the safest reasonable assumption, state it in the PR description, and keep moving.

## Adoption constraint

The people running this business today do it from memory and paper. If a screen takes more clicks than their current process, they will not use it. Order entry and receiving must be faster than the spreadsheet, not more thorough. Optimize those two flows for speed above everything else.

## Open decisions (do not block on these, use the stated default)

| Decision | Default until told otherwise |
|---|---|
| Distributor commission rate | 12.5%, stored in config |
| Candle configuration | 3-pack at $45 |
| Pain Be Gone configuration | Unknown quantity at $45 |
| Individual seller tracking within a group | Out of scope for Phase 1 |
| Multi-warehouse | Schema supports it, UI assumes one |
