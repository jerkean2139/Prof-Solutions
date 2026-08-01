# Schema Specification

Postgres. Phase 1 tables are marked **[P1]**. Phase 2 tables are stubbed so the relationships are right from the start, but do not build UI for them.

## Assumption to confirm

This schema assumes **campaign-based pre-order fundraising**, not stock-and-ship ecommerce. Meaning: a group runs a campaign for a fixed window, collects orders on paper and online, the campaign closes, then product is picked and delivered in bulk to the group who distributes to buyers.

That is how detergent fundraising normally works and it drives the entire structure. **If Profitable Solutions actually holds stock and ships individual orders continuously, this schema changes significantly.** Confirm before building.

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

Versioned by date so historical campaigns settle at the rate that applied when they ran. Do not overwrite rates.

### `commission_plan_lines` [P1 config]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| plan_id | uuid FK | |
| payee_role | text | `organization` or `distributor` |
| calc_type | text | `flat_per_unit` or `percent_of_retail` |
| value | numeric(12,4) | 12.00 flat, or 0.1250 percent |
| applies_to_product_id | uuid FK nullable | null means all products |

Current reality: organization gets `flat_per_unit` 12.00. Distributor is `percent_of_retail`, value undecided, defaulting to 0.1250.

---

## Organizations and people

### `organizations` [P1]
The fundraising groups. Schools, teams, churches, booster clubs.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| org_type | text | school, sports_team, church, other |
| contact_name | text | |
| contact_email | text | |
| contact_phone | text | |
| ghl_contact_id | text | link to GHL if they exist there |
| address_* | text | delivery address fields |
| deleted_at | timestamptz | |

### `reps` [P1]
Distributors, the feet on the street.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ghl_contact_id | text UNIQUE | **GHL is source of truth for identity** |
| display_name | text | cached from GHL for reporting speed |
| status | text | applicant, approved, active, paused, terminated |
| approved_at | timestamptz | |
| starter_kit_sent_at | timestamptz | |
| commission_plan_id | uuid FK | |
| deleted_at | timestamptz | |

Name, email, and phone are cached here for reporting but GHL wins on conflict. See the integration contract.

### `users` [P1]
Internal staff. Warehouse, admin, owner.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | text UNIQUE | |
| name | text | |
| role | text | admin, warehouse, sales, readonly |
| active | boolean | |

---

## Campaigns

### `campaigns` [P1]
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| organization_id | uuid FK | |
| rep_id | uuid FK nullable | who sourced it |
| name | text | "Northside HS Fall 2026" |
| commission_plan_id | uuid FK | locked at campaign creation |
| starts_on | date | |
| ends_on | date | order collection deadline |
| delivery_target_date | date | |
| goal_amount | numeric(12,2) | |
| status | text | draft, active, closed, picking, delivered, settled, cancelled |
| deleted_at | timestamptz | |

Status drives everything. Orders can only be added when `active`. Pick lists only generate when `closed`.

### `campaign_skus` [P1]
Which products are offered in this campaign, with optional price override.

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
| buyer_name | text | |
| buyer_phone | text nullable | |
| buyer_email | text nullable | |
| entry_channel | text | paper, online, phone |
| entered_by | uuid FK users | |
| subtotal | numeric(12,2) | |
| status | text | open, cancelled, fulfilled |
| notes | text | |
| created_at | timestamptz | |

Paper is the primary channel today. The entry screen must support rapid keyboard-only entry of a stack of order forms. This is the single most important UI in Phase 1.

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
| quantity_committed | integer | allocated to closed campaigns |
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

Generated by aggregating all `order_lines` across a closed campaign, grouped by SKU. The group gets one bulk delivery, not individual buyer boxes.

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

Packing slip is a rendered document off this record plus its pick list lines. Not a separate table.

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

### `campaign_settlements` [P2]
id, campaign_id, gross_revenue, organization_payout, distributor_commission, product_cost_total, gross_profit, status, settled_at

### `commission_ledger` [P2]
id, rep_id, campaign_id, amount, status (accrued, approved, paid), approved_by, paid_at

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
- `campaigns (status, ends_on)` — the operational dashboard
- `reps (ghl_contact_id)` — sync lookups

## Constraints worth enforcing in the database

- `orders` cannot be inserted unless parent campaign status is `active`
- `inventory_transactions.quantity_delta` cannot be zero
- `inventory_transactions.reason` required when `txn_type = 'adjustment'`
- `commission_plan_lines.value` must be positive
- No UPDATE or DELETE trigger on `inventory_transactions`

Put these in the database, not just the application layer. The application will get rewritten. The data has to survive it.
