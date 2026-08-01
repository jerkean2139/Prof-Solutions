# Decisions

Confirmed decisions, with the reasoning, so nobody re-litigates them from memory. Dated newest first. If a decision changes, add a new entry, do not edit the old one.

## 2026-08-01: model and architecture confirmed

The original docs assumed fixed-window pre-order fundraising. That was wrong. The confirmed model and the decisions that shape the build:

### 1. Model: team-based fundraising, held stock, bulk delivery
A group registers to sell, gets a store, buyers order, the team finalizes the sale in their portal, we pick from held stock and ship one bulk delivery to the team. The team distributes to buyers. We do not ship to individual buyers. We do not close on a calendar deadline. The team triggers the close by finalizing.

### 2. GoHighLevel is the front door (Path A)
GHL owns storefronts, all messaging, payment processing, and contact identity. The custom stack owns products, inventory, orders, fulfillment, commissions, and the portal's operational data, and orchestrates GHL with tags and custom fields.

Why: cheaper, keeps deliverability and opt-out compliance in one place, and the team can maintain it. The alternative (build storefronts, buyer CRM, and messaging in the custom stack) is far more to build and re-owns compliance liability for no real gain.

### 3. Payments: ACH via GHL and Accept Blue
Buyers pay by ACH in the store checkout, processed through GHL's Accept Blue integration. The custom stack stores a payment reference and status only, never raw bank credentials. PCI and NACHA scope stays with the processor.

### 4. Fulfillment: one bulk shipment to the team
The team distributes to individual buyers. Pick list stays bulk, aggregated by SKU across the finalized sale.

### 5. Contacts: two-level rollup to a master list
Every buyer becomes a customer. Each team sees its own customer list. All teams' customers feed a master Profitable Solutions client list. Contact identity is owned by GHL and linked by `ghl_contact_id`.

### 6. Inventory: held stock with forecasting
We hold inventory and forecast reorders from order history. Forecasting reads order and ledger data and never writes inventory. Forecasting UI and reorder are Phase 2.

### 7. Sellers: tracked in Phase 1, paid in Phase 2
Individual team members are sellers. They share a store link carrying a seller code, and get credit for what they sell. Per-seller commission is a config line added in Phase 2, not a code change. The `seller` payee role exists in `commission_plan_lines` now.

### 8. Auth: Clerk, wired now, enforced later
Clerk governs portal and app login and org membership. `clerk_user_id` and `clerk_org_id` are in the schema now, nullable. Dev and test run on mock data with enforcement off. Enforcement flips on in Phase 2. GHL identity and Clerk identity are separate systems for separate jobs and do not merge.

### 9. The seller and org portal is a PWA
Installable, works on mobile. The buyer storefront is GHL, not the PWA.

## Still open, using stated defaults

- Distributor commission rate: 12.5% in config (genuinely undecided between 10% and 15%)
- Pain Be Gone unit configuration: unknown quantity at $45
- Exact seller-attribution mechanism on a shared GHL store link: assumed to be a store link param carrying the seller code, captured on the order. Confirm against Accept Blue and GHL store capabilities during Phase 1 build.
