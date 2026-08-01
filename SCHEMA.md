# Schema Specification

Postgres. Phase 1 tables are marked **[P1]**. Phase 0 foundation tables are marked **[P0]**. Phase 2 tables are stubbed so the relationships are right from the start, but do not build UI for them.

## The confirmed model

This schema is **team-based fundraising with held stock and bulk delivery**, GoHighLevel as the front door. A group registers to sell, gets a GHL store, individual buyers order online and on paper, sellers inside the team get credit, the team finalizes the sale in their portal, and the custom stack picks against held inventory and ships one bulk delivery to the team. See `CLAUDE.md` and `BUSINESS-RULES.md`.

This replaces the earlier fixed-window pre-order assumption. Two things changed the schema most: the close is now group-triggered (a team finalizes, no calendar deadline), and individual buyers and sellers are captured and rolled up into org and master client lists.

---

## Identity and auth

Two identity systems, kept separate on purpose. See `INTEGRATION-CONTRACT.md`.

- **GoHighLevel** owns contact identity for reps, sellers, buyers, and org contacts. Linked by `ghl_contact_id`.
- **Clerk** governs who logs into the portal and app. Linked by `clerk_user_id` and `clerk_org_id`. Columns are added now and left nullable until enforcement flips on.

---

## Products

### `products` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | "Route 40 Candle", "Laundry Detergent" |
| brand | text | Route 40, Pain Be Gone, Profitable Solutions |
| category | text | detergent, candle, topical |
| owner_entity | text | which business owns this line |
| active | boolean | |
| deleted_at | timestamptz | |

`owner_entity` matters. Candles and Pain Be Gone belong to the legacy company. Detergent belongs to Profitable Solutions. Reporting needs to split by this.

### `skus` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| product_id | uuid FK | |
| sku_code | text UNIQUE | |
| description | text | "Blue, 5 gallon" |
| unit_config | text | "5 gallon bucket", "3-pack" |
| retail_price | numeric(12,2) | defaults to 45.00 |
| product_cost | numeric(12,2) | current landed cost |
| barcode | text | UPC if it exists |
| qr_code | text UNIQUE | what the phone scanner resolves |
| active | boolean | |

QR scanning resolves `qr_code` to a SKU. Index it.

---

## Commission configuration

### `commission_plans` [P1 config, P2 payout]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| effective_from | date | |
| effective_to | date | null means current |
| active | boolean | |

Versioned by date so historical sales settle at the rate that applied when they ran. Do not overwrite rates.

### `commission_plan_lines` [P1 config]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| plan_id | uuid FK | |
| payee_role | text | `organization`, `distributor`, or `seller` |
| calc_type | text | `flat_per_unit` or `percent_of_retail` |
| value | numeric(12,4) | 12.00 flat, or 0.1250 percent |
| applies_to_product_id | uuid FK nullable | null means all products |

Current reality: organization gets `flat_per_unit` 12.00. Distributor is `percent_of_retail`, value undecided, defaulting to 0.1250. `seller` is defined now so per-seller payout is a config row in Phase 2, not a code change. In Phase 1 sellers are credited (attribution), not paid.

---

## Organizations and people

### `organizations` [P1]
The fundraising teams. Schools, teams, churches, booster clubs.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| org_type | text | school, sports_team, church, other |
| status | text | prospect, onboarding, active, dormant |
| contact_name | text | cached from GHL |
| contact_email | text | cached from GHL |
| contact_phone | text | cached from GHL |
| ghl_contact_id | text | link to GHL, source of truth for identity |
| ghl_store_id | text nullable | the provisioned GHL funnel/store |
| store_slug | text UNIQUE nullable | stable public identifier for the team store |
| clerk_org_id | text nullable | portal org identity, nullable until enforced |
| address_* | text | delivery address fields |
| deleted_at | timestamptz | |

### `organization_agreements` [P1]
Captures what a team agreed to at onboarding so nothing surprises them later.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| organization_id | uuid FK | |
| terms_version | text | which terms they saw |
| terms_snapshot | text | the exact text shown, frozen |
| accepted_by | text | name of the person who accepted |
| accepted_at | timestamptz | |

### `sellers` [P1]
The team players and parents who sell product to the end buyer. They belong to one organization. Distinct from reps.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| organization_id | uuid FK | |
| ghl_contact_id | text UNIQUE | GHL is source of truth for identity |
| display_name | text | cached from GHL |
| seller_code | text UNIQUE | rides the store link, lands on the order |
| status | text | applicant, approved, active, paused |
| clerk_user_id | text nullable | portal login, nullable until enforced |
| deleted_at | timestamptz | |

### `reps` [P1]
People we recruit from the community to represent the product and the fundraising opportunity. They bring teams on board and are the distributor layer that earns the distributor commission. Distinct from sellers, who sell inside one team.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ghl_contact_id | text UNIQUE | GHL is source of truth for identity |
| display_name | text | cached from GHL for reporting speed |
| status | text | applicant, approved, active, paused, terminated |
| approved_at | timestamptz | |
| starter_kit_sent_at | timestamptz | |
| commission_plan_id | uuid FK | |
| deleted_at | timestamptz | |

### `customers` [P1]
End buyers. The master Profitable Solutions client list.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ghl_contact_id | text UNIQUE | GHL owns identity, created at checkout |
| display_name | text | cached from GHL |
| email | text nullable | cached |
| phone | text nullable | cached |
| first_order_at | timestamptz | |
| deleted_at | timestamptz | |

### `organization_customers` [P1]
Rolls a customer up to each team they bought through. The team sees its own list, Profitable Solutions sees the master list of all customers.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| organization_id | uuid FK | |
| customer_id | uuid FK | |
| first_order_at | timestamptz | |
| last_order_at | timestamptz | |

UNIQUE on (organization_id, customer_id). Maintained from orders, not authoritative on its own.

### `users` [P1]
Internal staff. Warehouse, admin, owner.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | text UNIQUE | |
| name | text | |
| role | text | admin, warehouse, sales, readonly |
| clerk_user_id | text nullable | nullable until enforced |
| active | boolean | |

---

## Sales

### `campaigns` [P1]
A team's fundraising sale. Org-facing word is "sale."

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| organization_id | uuid FK | |
| rep_id | uuid FK nullable | who sourced it |
| name | text | "Northside HS Fall 2026" |
| channel | text | fundraising, retail |
| commission_plan_id | uuid FK | locked at sale creation |
| starts_on | date | store goes live |
| status | text | draft, open, finalizing, finalized, picking, delivered, settled, cancelled |
| finalized_at | timestamptz nullable | the group-triggered close |
| finalized_by | text nullable | who finalized (team or staff) |
| goal_amount | numeric(12,2) | |
| next_sale_target | date nullable | growth loop countdown target |
| incentive_note | text nullable | growth loop offer |
| delivery_target_date | date nullable | |
| deleted_at | timestamptz | |

Status drives everything. Orders can only be added when `open`. Pick lists only generate when `finalized`. There is no calendar deadline that closes a sale. The team finalizes.

### `campaign_skus` [P1]
Which products are offered in this sale, with optional price override.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| campaign_id | uuid FK | |
| sku_id | uuid FK | |
| price_override | numeric(12,2) nullable | null means use sku.retail_price |

---

## Orders

### `orders` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| campaign_id | uuid FK | |
| order_number | text UNIQUE | human readable |
| customer_id | uuid FK | the buyer, rolled up to the master list |
| seller_id | uuid FK nullable | seller credit, null rolls up to the team only |
| entry_channel | text | online, paper, phone |
| entered_by | uuid FK users nullable | null when it came from the online store |
| subtotal | numeric(12,2) | |
| status | text | open, cancelled, fulfilled |
| notes | text | |
| created_at | timestamptz | |

Buyer identity lives on `customers`, not duplicated here. Online orders arrive from the GHL store. Paper and phone orders are typed by staff and must support rapid keyboard-only entry of a stack of forms.

### `order_lines` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| order_id | uuid FK | |
| sku_id | uuid FK | |
| quantity | integer | |
| unit_price | numeric(12,2) | snapshot at entry, never recalculated |
| extended | numeric(12,2) | generated column |

`unit_price` is a snapshot. If a SKU price changes later, historical orders do not move.

### `payments` [P1]
ACH captured in the GHL store and processed through Accept Blue. The custom stack stores a reference only. No raw bank data ever.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| order_id | uuid FK | |
| method | text | ach |
| amount | numeric(12,2) | |
| status | text | pending, authorized, captured, settled, failed, refunded |
| accept_blue_ref | text nullable | processor transaction id |
| ghl_transaction_id | text nullable | GHL side reference |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Never store account or routing numbers. Status updates arrive by webhook and are new writes, never deletes.

---

## Inventory

### `warehouses` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| address_* | text | |
| active | boolean | |

### `inventory_transactions` [P1] — APPEND ONLY
The single source of truth for stock. Never update, never delete.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| sku_id | uuid FK | |
| warehouse_id | uuid FK | |
| txn_type | text | receipt, pick, adjustment, return, transfer_in, transfer_out, cycle_count |
| quantity_delta | integer | signed. negative for picks. |
| unit_cost | numeric(12,2) nullable | populated on receipts |
| lot_id | uuid FK nullable | |
| reference_type | text nullable | purchase_order, pick_list, campaign, manual |
| reference_id | uuid nullable | |
| reason | text nullable | required for adjustments |
| created_by | uuid FK users | |
| created_at | timestamptz | |

Corrections are new offsetting rows with a `reason`. This is what makes the system auditable and what makes it trustworthy enough to replace legal pads.

### `inventory_lots` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| sku_id | uuid FK | |
| warehouse_id | uuid FK | |
| lot_code | text | |
| received_at | timestamptz | |
| unit_cost | numeric(12,2) | |
| expires_on | date nullable | matters for Pain Be Gone |

### `inventory_snapshots` [P1] — derived cache
| Column | Type | Notes |
|---|---|---|
| sku_id | uuid | |
| warehouse_id | uuid | |
| quantity_on_hand | integer | |
| quantity_committed | integer | allocated to finalized sales |
| quantity_available | integer | generated: on_hand minus committed |
| last_computed_at | timestamptz | |

PK is (sku_id, warehouse_id). Rebuilt from the ledger. Cached in Redis for the ops agent. **Never the authority.** A rebuild job must be able to regenerate this table from scratch and produce identical numbers.

---

## Fulfillment

### `pick_lists` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| campaign_id | uuid FK | |
| pick_list_number | text UNIQUE | |
| status | text | generated, in_progress, complete, cancelled |
| assigned_to | uuid FK users nullable | |
| generated_at | timestamptz | |
| completed_at | timestamptz | |

Generated by aggregating all `order_lines` across a finalized sale, grouped by SKU. The team gets one bulk delivery, not individual buyer boxes.

### `pick_list_lines` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| pick_list_id | uuid FK | |
| sku_id | uuid FK | |
| quantity_required | integer | |
| quantity_picked | integer | |
| lot_id | uuid FK nullable | |
| picked_by | uuid FK users nullable | |
| picked_at | timestamptz | |

Completing a pick list line writes a `pick` transaction to the ledger. That is the only way inventory decrements.

### `shipments` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| pick_list_id | uuid FK | |
| packing_slip_number | text UNIQUE | |
| carrier | text nullable | |
| tracking_number | text nullable | |
| shipped_at | timestamptz | |
| delivered_at | timestamptz | |
| delivery_signature | text nullable | |

One bulk shipment to the team. Packing slip is a rendered document off this record plus its pick list lines. Not a separate table.

---

## Phase 2 stubs

Define these tables now so foreign keys are correct. No UI in Phase 1.

### `vendors` [P2]
id, name, contact fields, payment_terms, lead_time_days, active

### `purchase_orders` [P2]
id, vendor_id, po_number, status, ordered_at, expected_at, subtotal

### `purchase_order_lines` [P2]
id, po_id, sku_id, quantity_ordered, quantity_received, unit_cost

Receiving against a PO writes `receipt` transactions to the inventory ledger.

### `demand_forecasts` [P2]
id, sku_id, warehouse_id, period, projected_units, reorder_point, computed_at. Derived from order and ledger history. Read only against inventory, never writes it.

### `campaign_settlements` [P2]
id, campaign_id, gross_revenue, organization_payout, distributor_commission, seller_commission, product_cost_total, gross_profit, status, settled_at

### `commission_ledger` [P2]
id, payee_type (rep, seller), payee_id, campaign_id, amount, status (accrued, approved, paid), approved_by, paid_at

### `territories` [P2]
id, name, postal_codes (text array), max_active_reps, active

### `rep_territories` [P2]
id, rep_id, territory_id, assigned_at, released_at

Saturation rule lives here: count active `rep_territories` against `territories.max_active_reps` before approving a new rep in that area.

---

## Indexes that matter

- `skus.qr_code` — every scan hits this
- `inventory_transactions (sku_id, warehouse_id, created_at)` — ledger rebuilds
- `order_lines (order_id)` and `order_lines (sku_id)`
- `orders (campaign_id)` — pick list generation
- `orders (customer_id)` and `orders (seller_id)` — list rollup and seller credit
- `payments (order_id)` and `payments (status)` — finalizable totals
- `organization_customers (organization_id)` and `(customer_id)` — list views
- `campaigns (status, organization_id)` — the operational dashboard
- `reps (ghl_contact_id)`, `sellers (ghl_contact_id)`, `customers (ghl_contact_id)` — sync lookups
- `organizations (store_slug)` — store resolution

## Constraints worth enforcing in the database

- `orders` cannot be inserted unless parent sale status is `open`
- `inventory_transactions.quantity_delta` cannot be zero
- `inventory_transactions.reason` required when `txn_type = 'adjustment'`
- `commission_plan_lines.value` must be positive
- `payments` must never carry a column for account or routing number
- No UPDATE or DELETE trigger on `inventory_transactions`

Put these in the database, not just the application layer. The application will get rewritten. The data has to survive it.
