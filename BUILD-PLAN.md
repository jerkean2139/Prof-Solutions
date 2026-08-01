# Build Plan

Re-mapped after the model was confirmed on 2026-08-01. The old plan built a warehouse tool. This one builds the money-in path first, then the growth loop and ops depth on top. Ship something a team can actually run a sale on before building the countdown timer.

See `DECISIONS.md` for the decisions behind this. Each phase ends with a deploy and a smoke test, not green unit tests.

## Phase 0: foundation

No end-user UI. Get the bones right.

- Postgres schema from `SCHEMA.md`, every migration reversible and checked in
- The database constraints listed in `SCHEMA.md`, in the database, not just the app
- Append-only guard on `inventory_transactions` (no UPDATE or DELETE trigger)
- Mock-data seeds for products, SKUs, a sample team, sellers, customers, and a sale
- Clerk wired into the app boundary, enforcement off, columns nullable
- GHL API client with the Redis outbound queue, retry, backoff, dead letter, and full request/response logging
- Accept Blue payment-reference model and webhook intake stub
- Commission config tables seeded with the org $12 flat and distributor 12.5% percent

**Done when** migrations run up and down cleanly, seeds load, and the inventory snapshot rebuild job reproduces identical numbers from the ledger.

## Phase 1: operational core, the money-in path

The whole loop from a team registering to stock shipping. Optimize order entry, receiving, and finalize for speed.

1. Products and SKUs with QR/barcode resolution
2. Inventory ledger: receipt, pick, adjustment transactions, with the negative-on-hand flag on a discrepancy report
3. Phone-based QR scanning for inbound receiving
4. Team onboarding: capture the org, present terms, record `organization_agreements`, provision the GHL store, seed the catalog
5. Sale creation and the `campaign_skus` offer list with price override
6. Buyer order intake:
   - Online: GHL store webhook creates the order, links or creates the customer, applies seller attribution, records the payment reference
   - Paper and phone: keyboard-first entry, type-to-find SKU, live total, save-and-next in one keystroke
7. ACH payment reference capture and status webhooks through GHL and Accept Blue
8. Group-triggered finalize from the portal (and staff override), which locks totals and starts the growth-loop data write
9. Pick list generation from a finalized sale, marked short when inventory cannot cover
10. Completing pick lines writes `pick` transactions, the only path that decrements stock
11. Packing slip and one bulk shipment record to the team, tracking pushed to GHL
12. Customer and seller capture feeding `organization_customers` and the master list

**Done when** a team can be registered, run a sale, take buyer orders online with ACH and on paper, finalize in their portal, and the system produces an accurate bulk pick list, ships one delivery, reflects inventory against the ledger, and has recorded every customer and seller, with no spreadsheet touched. Deploy and smoke test the full loop end to end.

## Phase 2: portal, growth loop, and ops depth

Layer the retention loop and the operational depth on the working core.

- Org portal: order forms, order history, and the team's own customer base view
- Seller leaderboards and per-seller commission (add the `seller` config line, turn on payout math)
- Growth loop live: on finalize, write next-sale eligibility, incentive, and countdown to GHL, tag `next-sale-eligible`, GHL runs the re-engagement workflow; portal shows the countdown
- Inventory forecasting and reorder points from order history (`demand_forecasts`), read-only against inventory
- Vendor management and purchase orders, receiving against a PO
- Commission settlement and the payout ledger
- Cost analysis reporting, split by `owner_entity` and `channel`
- PWA packaging of the seller and org portal
- Clerk enforcement turned on, mock data retired

## Phase 3: intelligence and dashboards

- Read-only ops AI agent with a read-only Postgres role, querying available (not on-hand) inventory
- Front-end web AI agent
- Owner dashboard

## Guardrails that apply in every phase

- Feature branch to PR, never push to main
- Money is `NUMERIC(12,2)`, commission rates in config, the $45 price a per-SKU default with sale override
- The custom stack never sends a message and never stores raw bank data
- Every table carries `created_at`, `updated_at`, `created_by`, soft delete with `deleted_at`
- State assumptions in the PR description when a requirement is ambiguous, then keep moving
