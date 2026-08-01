# Business Rules

Plain-English logic the code has to enforce. When code and this document disagree, this document is the intent.

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

The plan is locked to the campaign at creation time. A rate change next quarter does not retroactively alter a campaign that already ran.

---

## Campaign lifecycle

```
draft → active → closed → picking → delivered → settled
```

Any state can move to `cancelled`.

**draft.** Being set up. Organization selected, SKUs chosen, dates set. No orders allowed.

**active.** Order collection window is open. Orders can be entered. This is the only state where orders can be created.

**closed.** Collection deadline passed. No new orders. Totals lock. Pick list can be generated.

**picking.** Pick list generated and being worked. Inventory commits against the campaign.

**delivered.** Shipment recorded, bulk delivery made to the organization.

**settled.** Payouts calculated and recorded. Phase 2.

Rules:
- Orders cannot be created, edited, or deleted unless status is `active`
- Pick list can only be generated from `closed`
- A campaign cannot close if it has zero orders. Prompt to cancel instead.
- Reopening a closed campaign requires an admin override and gets logged

---

## Order entry

Paper is the primary channel. Staff will sit with a stack of order forms and type.

Requirements:
- Keyboard-only entry with no mouse required to complete an order
- SKU selection by typing a code or short name, not by scrolling a dropdown
- Running order total visible without a page refresh
- Save and immediately start the next order in one keystroke
- Duplicate buyer name in the same campaign is a soft warning, not an error. Families order twice.

`unit_price` on each line is snapshotted at entry from the campaign price or the SKU price. It never recalculates later.

---

## Inventory rules

**Receiving.** Scan the QR code, system resolves the SKU, enter quantity, confirm. Writes a `receipt` transaction. If received against a purchase order in Phase 2, link the reference.

**Picking.** Only completing a pick list line decrements inventory. It writes a `pick` transaction with a negative delta. There is no other path to reduce stock.

**Adjustments.** Require a reason string. Written as a normal transaction with a signed delta. Never edit history.

**Cycle counts.** A count writes an adjustment transaction for the difference between counted and expected, with the count reference. The expected value is never overwritten in place.

**Negative on-hand is allowed but flagged.** Do not block the operation. In a business coming off paper, the ledger will disagree with the shelf early on and blocking picks will make staff abandon the system. Surface it loudly on a discrepancy report instead.

**Committed vs available.** When a campaign enters `picking`, its pick list quantities are committed. Available equals on-hand minus committed. Reports and the ops agent must use available, not on-hand, when answering "can we fulfill this."

---

## Pick list generation

Triggered from a `closed` campaign.

1. Sum `order_lines.quantity` across all open orders in the campaign, grouped by SKU
2. Create one `pick_list_line` per SKU with the total quantity
3. Compare each line against available inventory
4. If any line exceeds available, generate the list anyway and mark it short, listing the gap

The organization gets one bulk delivery. Individual buyer separation happens on their end, not ours. Do not build per-buyer boxes in Phase 1.

---

## Territory saturation (Phase 2)

Before a rep is approved for a territory:

1. Count active `rep_territories` for that territory
2. If count is at or above `territories.max_active_reps`, block approval and surface which territory is full
3. Approval override requires an admin and gets logged

The purpose is protecting existing reps' earnings. Oversaturating an area is how the rep network dies.

---

## Product ownership and reporting

`products.owner_entity` splits reporting between business entities. Candles and Pain Be Gone belong to the legacy company. Detergent belongs to Profitable Solutions.

Every revenue, cost, and margin report must be filterable by `owner_entity`, and the default view should show them separately rather than combined. These are legally different businesses sharing a fulfillment operation. The numbers cannot be blended.

**Channel restriction:** candles and Pain Be Gone sold through fundraising go exclusively through Profitable Solutions. Non-fundraising channels such as retail and gift shops stay open to the legacy company. Phase 1 does not need to enforce this in code, but reporting has to be able to distinguish the channels, so model a `channel` field on campaigns and future retail orders now.

---

## Data migration reality

There is no system to migrate from. Excel and legal pads.

Phase 0 work before go-live:
1. Extract and normalize the SKU list from spreadsheets. Expect inconsistent naming for the same product.
2. Decide whether any order history is worth importing. Probably not. Start clean.
3. Physical inventory count on day one. That count is the opening balance and gets written as `receipt` transactions dated go-live.
4. Organization list import from spreadsheets into GHL first, then sync down.

Do not attempt to reconcile historical spreadsheet inventory against a physical count. Count the shelf, trust the shelf, start the ledger there.
