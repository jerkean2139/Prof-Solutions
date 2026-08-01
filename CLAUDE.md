# CLAUDE.md: Profitable Solutions Operating System

## What this is

A custom operational backbone for a fundraising products company doing roughly $6.5M a year. They currently run on Excel and legal pads. There is no ERP, no inventory software, no existing system to integrate with or migrate from.

GoHighLevel is already the CRM and marketing hub. This application does not replace it. It extends it. GoHighLevel stays the front door for anything a buyer or contact sees or receives. This application is the operational engine behind it.

## The model, confirmed

This is **team-based fundraising with held stock and bulk delivery**. The flow:

1. A group (school, team, church, booster club) registers to sell through a self-serve onboarding that sets expectations up front so nothing surprises them later.
2. The system provisions that team a store with the product catalog. The store is a GoHighLevel funnel. The custom stack feeds it products and prices and receives its orders.
3. Individual buyers order on the team store. Team members (sellers) share their own store link and get credit for what they sell.
4. Payment is ACH, captured in the checkout and processed through GoHighLevel's Accept Blue integration. The custom stack stores a payment reference and status, never raw bank credentials.
5. The team logs into their portal and **finalizes the sale**. Finalizing is the close. It is group-triggered, not a fixed calendar deadline.
6. The custom stack aggregates the finalized orders into one bulk pick list, picks against held inventory, and ships one delivery to the team. The team distributes to buyers.
7. Every buyer feeds the team's customer list, and every team's list feeds a master Profitable Solutions client list. After a sale closes, the growth loop asks the team to register their next sale for an incentive, with a countdown to it in their portal.

We hold inventory and forecast reorders from order history. We do not ship to individual buyers, and we do not run fixed-window pre-order campaigns that close on a date.

## Stack

- Claude Code for the build
- Railway for hosting
- Postgres for primary data
- Redis for caching and job queues
- GoHighLevel API for CRM, storefronts, messaging, and payments (Accept Blue)
- Clerk for authentication and org membership. Wired into the schema and app boundaries now, enforced after dev and test on mock data.
- The seller and org portal ships as an installable PWA. The buyer storefront is GoHighLevel, not the PWA.

## The hard boundary

Read this before writing any code.

**GoHighLevel owns:**
- Contact identity for reps, sellers, buyers, and org contacts (name, email, phone, address)
- Team storefronts and every buyer-facing funnel and landing page
- ACH checkout and payment processing through the Accept Blue integration
- All SMS, email, and conversations, including the post-sale growth loop
- Rep application pipeline and onboarding sequences
- Marketing campaigns, retargeting, pixels, per-org marketing materials

**This application owns:**
- Products and SKUs
- Team fundraising sales, orders, and order lines
- Sellers and per-seller credit
- Customers as operational records, and the org-list and master-list rollup
- Inventory (the ledger, the counts, the lots) and demand forecasting
- Pick lists, packing slips, shipments
- Commission calculation and settlement
- Vendor purchase orders
- Reporting, dashboards, and the org portal's operational data

**Never duplicate a GHL capability here.** Storefronts, messaging, payment processing, and contact identity live in GoHighLevel. The custom stack does the operational work and orchestrates GHL with tags and custom fields. If a feature already exists in GoHighLevel, use the API. When in doubt, ask before building it.

See `INTEGRATION-CONTRACT.md` for the exact sync rules and `DECISIONS.md` for the confirmed decisions behind this boundary.

## Phase scope

The phases were re-mapped after the model was confirmed. See `BUILD-PLAN.md` for the detail. Summary:

### Phase 0: foundation
Schema and reversible migrations, mock-data seeds, Clerk wired but not enforced, GHL and Accept Blue integration contracts stubbed, payment-reference model. No end-user UI.

### Phase 1: operational core, the money-in path
1. Products and SKUs with QR/barcode resolution
2. Inventory ledger with receipt, pick, and adjustment transactions
3. Phone-based QR scanning for inbound receiving
4. Team onboarding record and agreement capture
5. Sale creation and GHL store provisioning hooks
6. Buyer order intake from the GHL store, plus keyboard-first paper and phone entry
7. ACH payment reference capture through GHL and Accept Blue
8. Group-triggered finalize, bulk pick list, packing slip, bulk shipment to the team
9. Customer and seller capture feeding the org list and the master list

**Phase 1 is done when** a team can be registered, run a sale, take buyer orders online with ACH, finalize in their portal, and the system produces an accurate bulk pick list, ships one delivery to the team, reflects inventory against the ledger, and has recorded every customer and seller, without anyone touching a spreadsheet.

### Phase 2: portal, growth loop, and ops depth
Org portal (order forms, order history, customer base view), seller leaderboards and per-seller commission, the micro-CRM re-engagement loop through GHL (sale complete, next-sale incentive, countdown), inventory forecasting and reorder, vendor purchase orders, commission settlement and payout, PWA packaging, and Clerk enforcement turned on.

### Phase 3
Read-only ops AI agent (natural language queries against the database), front-end web AI agent, owner dashboard.

## Non-negotiable rules

1. **Inventory transactions are append-only.** Never UPDATE or DELETE a row in `inventory_transactions`. Corrections are new offsetting rows. On-hand quantity is derived from the ledger, cached for speed, never authoritative on its own.

2. **Money is `NUMERIC(12,2)`.** Never float, never double precision. Not once.

3. **Commission values live in config tables, never in code.** The distributor rate is still undecided (10% or 15%). If a rate is hardcoded anywhere, that is a bug.

4. **The $45 unit price is a default, not a constant.** It is the business anchor today. Model it as a per-SKU value with sale-level override.

5. **Every table gets `created_at`, `updated_at`, `created_by`.** This business will eventually be audited. Assume it.

6. **Soft delete only.** Use `deleted_at`. Nothing gets hard deleted.

7. **The custom stack never stores raw bank credentials.** ACH runs through GoHighLevel and Accept Blue. We keep a payment reference, method, and status. PCI and NACHA scope stays with the processor.

8. **The custom stack never sends a message directly.** Every buyer-facing and team-facing message, including the growth loop, goes out through GoHighLevel. We set tags and custom fields. GHL sends.

9. **Clerk is the identity boundary.** Wire `clerk_user_id` and `clerk_org_id` into the schema and app now. Enforcement flips on after dev and test. Do not hardcode auth around it.

10. **The AI agent gets a read-only Postgres role in Phase 3.** It never writes inventory. Not even a little.

11. **Every schema migration is reversible and checked in.** No manual database changes, ever.

## Working agreement

- Feature branch to PR. Never push to main.
- State your assumptions before writing code, not after.
- Green tests are not a working feature. Deploy plus smoke test before calling anything done.
- If a requirement is ambiguous, make the safest reasonable assumption, state it in the PR description, and keep moving.

## Adoption constraint

The people running this business today do it from memory and paper. If a screen takes more clicks than their current process, they will not use it. Order entry, receiving, and sale finalize must be faster than the spreadsheet, not more thorough. Optimize those flows for speed above everything else.

## Open decisions (do not block on these, use the stated default)

| Decision | Default until told otherwise |
|---|---|
| Distributor commission rate | 12.5%, stored in config |
| Per-seller commission | Tracked for credit in Phase 1, monetized in Phase 2 |
| Candle configuration | 3-pack at $45 |
| Pain Be Gone configuration | Unknown quantity at $45 |
| Seller attribution on a shared store link | Seller code carried as a GHL store link param, captured on the order |
| Multi-warehouse | Schema supports it, UI assumes one |

Confirmed decisions live in `DECISIONS.md`.
