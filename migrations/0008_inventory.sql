-- migrate:up

CREATE TABLE warehouses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  address_line1  text,
  address_city   text,
  address_state  text,
  address_postal text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  deleted_at     timestamptz
);

CREATE TRIGGER warehouses_set_updated_at
  BEFORE UPDATE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE inventory_lots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id       uuid NOT NULL REFERENCES skus(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  lot_code     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  unit_cost    numeric(12,2) NOT NULL,
  expires_on   date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id),
  deleted_at   timestamptz
);

CREATE TRIGGER inventory_lots_set_updated_at
  BEFORE UPDATE ON inventory_lots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Rule 1: the single source of truth for stock. APPEND ONLY. On-hand is
-- derived from this ledger, never authoritative on its own.
CREATE TABLE inventory_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id         uuid NOT NULL REFERENCES skus(id),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  txn_type       text NOT NULL CHECK (txn_type IN
                   ('receipt', 'pick', 'adjustment', 'return',
                    'transfer_in', 'transfer_out', 'cycle_count')),
  -- Signed. Negative for picks. A zero delta is meaningless, so forbid it.
  quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
  unit_cost      numeric(12,2),
  lot_id         uuid REFERENCES inventory_lots(id),
  reference_type text CHECK (reference_type IN
                   ('purchase_order', 'pick_list', 'campaign', 'manual')),
  reference_id   uuid,
  -- Reason is required for adjustments. Corrections are new offsetting rows.
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  CONSTRAINT adjustment_requires_reason
    CHECK (txn_type <> 'adjustment' OR reason IS NOT NULL)
);

-- Ledger rebuilds walk this index.
CREATE INDEX idx_inv_txn_sku_wh_created
  ON inventory_transactions(sku_id, warehouse_id, created_at);

-- Append-only enforcement. Rule 1 says corrections are new offsetting rows,
-- never edits. Block UPDATE and DELETE at the database, where it cannot be
-- bypassed by a future application.
CREATE OR REPLACE FUNCTION block_inventory_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_transactions is append-only: % is not allowed. Write an offsetting row instead.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_transactions_no_update
  BEFORE UPDATE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION block_inventory_mutation();

CREATE TRIGGER inventory_transactions_no_delete
  BEFORE DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION block_inventory_mutation();

-- Derived cache. Rebuilt from the ledger. Never the authority. quantity_available
-- is generated so it can never disagree with on_hand minus committed.
CREATE TABLE inventory_snapshots (
  sku_id             uuid NOT NULL REFERENCES skus(id),
  warehouse_id       uuid NOT NULL REFERENCES warehouses(id),
  quantity_on_hand   integer NOT NULL DEFAULT 0,
  quantity_committed integer NOT NULL DEFAULT 0,
  quantity_available integer GENERATED ALWAYS AS (quantity_on_hand - quantity_committed) STORED,
  last_computed_at   timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  PRIMARY KEY (sku_id, warehouse_id)
);

CREATE TRIGGER inventory_snapshots_set_updated_at
  BEFORE UPDATE ON inventory_snapshots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS inventory_snapshots;
DROP TRIGGER IF EXISTS inventory_transactions_no_delete ON inventory_transactions;
DROP TRIGGER IF EXISTS inventory_transactions_no_update ON inventory_transactions;
DROP FUNCTION IF EXISTS block_inventory_mutation();
DROP TABLE IF EXISTS inventory_transactions;
DROP TABLE IF EXISTS inventory_lots;
DROP TABLE IF EXISTS warehouses;
