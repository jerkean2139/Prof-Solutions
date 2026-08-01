-- migrate:up

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns(id),
  order_number  text UNIQUE NOT NULL,
  -- Buyer identity lives on customers, rolled up to the master list.
  customer_id   uuid NOT NULL REFERENCES customers(id),
  -- null rolls up to the team only (no individual seller credit).
  seller_id     uuid REFERENCES sellers(id),
  entry_channel text NOT NULL CHECK (entry_channel IN ('online', 'paper', 'phone')),
  -- null when the order arrived from the online store rather than staff entry.
  entered_by    uuid REFERENCES users(id),
  subtotal      numeric(12,2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled', 'fulfilled')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  deleted_at    timestamptz
);

CREATE INDEX idx_orders_campaign_id ON orders(campaign_id);
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_seller_id ON orders(seller_id);

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Business rule: orders can only be created, edited, or deleted while the
-- parent sale is 'open'. Enforced in the database, not just the app, because
-- the app will get rewritten and the data has to survive it.
CREATE OR REPLACE FUNCTION enforce_order_sale_open()
RETURNS trigger AS $$
DECLARE
  sale_status text;
  target_campaign uuid;
BEGIN
  target_campaign := COALESCE(NEW.campaign_id, OLD.campaign_id);
  SELECT status INTO sale_status FROM campaigns WHERE id = target_campaign;
  IF sale_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'orders can only be % when the sale is open (sale is %)',
      TG_OP, COALESCE(sale_status, 'missing');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_require_open_sale
  BEFORE INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION enforce_order_sale_open();

CREATE TABLE order_lines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders(id),
  sku_id     uuid NOT NULL REFERENCES skus(id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  -- Snapshot at entry, never recalculated. If a SKU price changes later,
  -- historical orders do not move.
  unit_price numeric(12,2) NOT NULL,
  -- Generated so the line total can never drift from quantity * unit_price.
  extended   numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz
);

CREATE INDEX idx_order_lines_order_id ON order_lines(order_id);
CREATE INDEX idx_order_lines_sku_id ON order_lines(sku_id);

CREATE TRIGGER order_lines_set_updated_at
  BEFORE UPDATE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ACH captured in the GHL store and processed through Accept Blue. The custom
-- stack stores a reference only. Rule 7: never raw bank credentials, ever.
-- There is deliberately no account_number or routing_number column here.
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  method             text NOT NULL DEFAULT 'ach' CHECK (method IN ('ach')),
  amount             numeric(12,2) NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'authorized', 'captured', 'settled', 'failed', 'refunded')),
  accept_blue_ref    text,
  ghl_transaction_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  deleted_at         timestamptz
);

CREATE INDEX idx_payments_order_id ON payments(order_id);
CREATE INDEX idx_payments_status ON payments(status);

CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS order_lines;
DROP TRIGGER IF EXISTS orders_require_open_sale ON orders;
DROP FUNCTION IF EXISTS enforce_order_sale_open();
DROP TABLE IF EXISTS orders;
