# Business Rules

Plain-English logic the code has to enforce. When code and this document disagree, this document is the intent.

The model is team-based fundraising with held stock and bulk delivery. See `CLAUDE.md` for the confirmed flow and `DECISIONS.md` for the decisions behind it.

## Unit economics

Every product sells for **$45 per unit**, regardless of what the unit is. The unit configuration changes so the price does not.

- Detergent: existing bucket and jug sizes
- Candles: 3-pack
- Pain Be Gone: quantity to be determined

On a $45 unit:

| Layer | Amount | Type |
|---|---|---|
| Fundraising organization | $12.00 | flat per unit (26.67%) |
| Distributor / rep | 12.5% default | percent of retail, rate not final |
| Product cost | per SKU | varies |
| Company gross profit | remainder | |

**Both payout rates come from `commission_plan_lines`.** Nothing hardcoded. The distributor rate is genuinely undecided between 10% and 15% and will change. If changing it requires a deploy, it was built wrong.

Individual sellers inside a team are tracked for credit in Phase 1 (who sold what). Paying sellers a cut is a Phase 2 config line, not a code change.

The plan is locked to the sale at creation time. A rate change next quarter does not retroactively alter a sale that already ran.

---

## Team onboarding

A group registers itself to sell through self-serve onboarding. The point of onboarding is that the team agrees to the terms up front so nothing surprises them later.

Requirements:
- Capture the organization, its contact, and its delivery address
- Present the terms (pricing, payout, delivery model, timelines) and record acceptance as an `organization_agreements` row with the terms version, who accepted, and when
- On completion, provision the team store (a GoHighLevel funnel) and seed it with the active catalog
- The organization contact is created in GoHighLevel first. The local `organizations` record links by `ghl_contact_id`

A team cannot open a sale until onboarding is complete and terms are accepted.

---

## Sale lifecycle

The org-facing word is "sale." The table is `campaigns`.

```
draft → open → finalizing → finalized → picking → delivered → settled
```

Any state can move to `cancelled`.

**draft.** Being set up. Organization selected, SKUs chosen, store provisioning queued. No orders allowed.

**open.** The store is live and collecting orders. Buyers order online, staff enter paper and phone orders. This is the only state where orders can be created.

**finalizing.** The team clicked finalize in their portal. Store intake closes, in-flight ACH payments are allowed to settle, totals are being locked. No new orders.

**finalized.** Totals locked. Pick list can be generated. This is the group-triggered close. There is no calendar deadline that forces it.

**picking.** Pick list generated and being worked. Inventory commits against the sale.

**delivered.** Bulk shipment recorded, one delivery made to the organization.

**settled.** Payouts calculated and recorded. Phase 2.

Rules:
- Orders can only be created, edited, or deleted when status is `open`
- A team triggers `finalizing` and `finalized` from their portal. Staff can also finalize on their behalf
- Pick list can only be generated from `finalized`
- A sale cannot finalize with zero orders. Prompt to cancel instead
- Reopening a finalized sale requires an admin override and gets logged
- On `finalized`, the growth loop starts: tag the org `sale-complete`, compute next-sale eligibility and the incentive, write the countdown target to GHL. GHL sends the messages

---

## Order entry and buyer capture

Two intake paths feed the same `orders` table.

**Online.** The buyer orders on the team store (a GHL funnel). GHL captures the buyer contact, the seller attribution from the store link, and the ACH payment through Accept Blue, then hands the order to the custom stack. The custom stack records the order, links the customer, credits the seller, and stores the payment reference.

**Paper and phone.** Staff sit with a stack of forms and type. This flow must be fast:
- Keyboard-only entry with no mouse required to complete an order
- SKU selection by typing a code or short name, not by scrolling a dropdown
- Running order total visible without a page refresh
- Save and immediately start the next order in one keystroke
- Duplicate buyer name in the same sale is a soft warning, not an error. Families order twice

`unit_price` on each line is snapshotted at entry from the sale price or the SKU price. It never recalculates later.

**Seller attribution.** Each seller shares a store link carrying their seller code. The code rides through GHL as a store link parameter and lands on the order as `seller_id`. Paper and phone orders capture the seller by code at entry. An order with no seller is allowed and rolls up to the team only.

**Customer rollup.** Every order links a `customer`. A customer belongs to the master Profitable Solutions client list and is associated with the team through `organization_customers`. The team sees its own customers in the portal. Profitable Solutions sees all of them in the master list. Contact identity itself is owned by GoHighLevel and linked by `ghl_contact_id`. See `INTEGRATION-CONTRACT.md`.

---

## Payments

ACH only, captured in the GHL store checkout and processed through the Accept Blue integration.

- The custom stack never sees or stores raw bank account or routing numbers. That data lives with Accept Blue and GHL
- The custom stack stores a `payments` row with method, amount, status, and the Accept Blue and GHL references
- Payment status flows `pending → authorized → captured → settled`, with `failed` and `refunded` as terminal branches
- An order is not counted toward a finalizable total until its payment is at least `authorized`
- A payment failure does not delete the order. It flags it for follow-up. GHL owns the dunning message

---

## Inventory rules

We hold stock. Inventory is real and forecasted from order history.

**Receiving.** Scan the QR code, system resolves the SKU, enter quantity, confirm. Writes a `receipt` transaction. If received against a purchase order in Phase 2, link the reference.

**Picking.** Only completing a pick list line decrements inventory. It writes a `pick` transaction with a negative delta. There is no other path to reduce stock.

**Adjustments.** Require a reason string. Written as a normal transaction with a signed delta. Never edit history.

**Cycle counts.** A count writes an adjustment transaction for the difference between counted and expected, with the count reference. The expected value is never overwritten in place.

**Negative on-hand is allowed but flagged.** Do not block the operation. In a business coming off paper, the ledger will disagree with the shelf early on and blocking picks will make staff abandon the system. Surface it loudly on a discrepancy report instead.

**Committed vs available.** When a sale enters `finalized`, its order quantities are committed. Available equals on-hand minus committed. Reports and the ops agent must use available, not on-hand, when answering "can we fulfill this."

**Forecasting (Phase 2).** Reorder points are derived from order history per SKU. The forecast reads the order and ledger data. It never writes inventory.

---

## Pick list generation

Triggered from a `finalized` sale.

1. Sum `order_lines.quantity` across all open orders in the sale, grouped by SKU
2. Create one `pick_list_line` per SKU with the total quantity
3. Compare each line against available inventory
4. If any line exceeds available, generate the list anyway and mark it short, listing the gap

The team gets one bulk delivery. Individual buyer separation happens on their end, not ours. Do not build per-buyer boxes.

---

## Growth loop (Phase 2 messaging, wired in Phase 1)

The purpose is to turn one sale into the next one.

1. On `finalized`, the custom stack computes the team's next-sale eligibility window and the incentive
2. It writes the countdown target and incentive to GHL custom fields on the org contact and applies the tag `next-sale-eligible`
3. GHL runs the workflow that messages the team and shows the offer
4. The team's portal shows the countdown to their next sale, read from the same data

The custom stack never sends the message. It sets the data and the tag. GHL sends. This keeps deliverability, compliance, and opt-out in one place.

---

## Product ownership and reporting

`products.owner_entity` splits reporting between business entities. Candles and Pain Be Gone belong to the legacy company. Detergent belongs to Profitable Solutions. Reporting needs to split by this.

Every revenue, cost, and margin report must be filterable by `owner_entity`, and the default view should show them separately rather than combined. These are legally different businesses sharing a fulfillment operation. The numbers cannot be blended.

**Channel restriction:** candles and Pain Be Gone sold through fundraising go exclusively through Profitable Solutions. Non-fundraising channels such as retail and gift shops stay open to the legacy company. Reporting has to distinguish the channels, so keep the `channel` field on sales and any future retail orders.

---

## Data migration reality

There is no system to migrate from. Excel and legal pads.

Phase 0 work before go-live:
1. Extract and normalize the SKU list from spreadsheets. Expect inconsistent naming for the same product.
2. Decide whether any order history is worth importing. Probably not. Start clean.
3. Physical inventory count on day one. That count is the opening balance and gets written as `receipt` transactions dated go-live.
4. Organization and existing customer list import from spreadsheets into GHL first, then sync down.

Do not attempt to reconcile historical spreadsheet inventory against a physical count. Count the shelf, trust the shelf, start the ledger there.
