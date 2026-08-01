-- migrate:up
-- Phase 2 tables, defined now so foreign keys are correct from the start.
-- No UI touches these in Phase 1.

CREATE TABLE vendors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  contact_name   text,
  contact_email  text,
  contact_phone  text,
  payment_terms  text,
  lead_time_days integer,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  deleted_at     timestamptz
);

CREATE TRIGGER vendors_set_updated_at
  BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   uuid NOT NULL REFERENCES vendors(id),
  po_number   text UNIQUE NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  ordered_at  timestamptz,
  expected_at timestamptz,
  subtotal    numeric(12,2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  deleted_at  timestamptz
);

CREATE TRIGGER purchase_orders_set_updated_at
  BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id             uuid NOT NULL REFERENCES purchase_orders(id),
  sku_id            uuid NOT NULL REFERENCES skus(id),
  quantity_ordered  integer NOT NULL,
  quantity_received integer NOT NULL DEFAULT 0,
  unit_cost         numeric(12,2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  deleted_at        timestamptz
);

CREATE TRIGGER purchase_order_lines_set_updated_at
  BEFORE UPDATE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Derived from order and ledger history. Reads inventory, never writes it.
CREATE TABLE demand_forecasts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id         uuid NOT NULL REFERENCES skus(id),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  period         text NOT NULL,
  projected_units integer,
  reorder_point  integer,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  deleted_at     timestamptz
);

CREATE TRIGGER demand_forecasts_set_updated_at
  BEFORE UPDATE ON demand_forecasts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE campaign_settlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id           uuid NOT NULL REFERENCES campaigns(id),
  gross_revenue         numeric(12,2),
  organization_payout   numeric(12,2),
  distributor_commission numeric(12,2),
  seller_commission     numeric(12,2),
  product_cost_total    numeric(12,2),
  gross_profit          numeric(12,2),
  status                text NOT NULL DEFAULT 'draft',
  settled_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  deleted_at            timestamptz
);

CREATE TRIGGER campaign_settlements_set_updated_at
  BEFORE UPDATE ON campaign_settlements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Payee is a rep or a seller. Both earn, both settle here.
CREATE TABLE commission_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_type  text NOT NULL CHECK (payee_type IN ('rep', 'seller')),
  payee_id    uuid NOT NULL,
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  amount      numeric(12,2) NOT NULL,
  status      text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'approved', 'paid')),
  approved_by uuid REFERENCES users(id),
  paid_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  deleted_at  timestamptz
);

CREATE TRIGGER commission_ledger_set_updated_at
  BEFORE UPDATE ON commission_ledger FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE territories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  postal_codes    text[] NOT NULL DEFAULT '{}',
  max_active_reps integer NOT NULL DEFAULT 1,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz
);

CREATE TRIGGER territories_set_updated_at
  BEFORE UPDATE ON territories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE rep_territories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id       uuid NOT NULL REFERENCES reps(id),
  territory_id uuid NOT NULL REFERENCES territories(id),
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id),
  deleted_at   timestamptz
);

CREATE TRIGGER rep_territories_set_updated_at
  BEFORE UPDATE ON rep_territories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS rep_territories;
DROP TABLE IF EXISTS territories;
DROP TABLE IF EXISTS commission_ledger;
DROP TABLE IF EXISTS campaign_settlements;
DROP TABLE IF EXISTS demand_forecasts;
DROP TABLE IF EXISTS purchase_order_lines;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS vendors;
