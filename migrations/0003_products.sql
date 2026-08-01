-- migrate:up

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  brand        text NOT NULL,
  category     text NOT NULL CHECK (category IN ('detergent', 'candle', 'topical')),
  -- Splits reporting between legal entities. Candles and Pain Be Gone belong
  -- to the legacy company, detergent to Profitable Solutions. Never blended.
  owner_entity text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id),
  deleted_at   timestamptz
);

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE skus (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id),
  sku_code      text UNIQUE NOT NULL,
  description   text,
  unit_config   text,
  -- Rule 4: $45 is a default, not a constant. Per-SKU, overridable per sale.
  retail_price  numeric(12,2) NOT NULL DEFAULT 45.00,
  -- Rule 2: money is NUMERIC(12,2). Never float.
  product_cost  numeric(12,2),
  barcode       text,
  qr_code       text UNIQUE,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  deleted_at    timestamptz
);

-- Every phone scan resolves qr_code to a SKU. Index it.
CREATE INDEX idx_skus_qr_code ON skus(qr_code);

CREATE TRIGGER skus_set_updated_at
  BEFORE UPDATE ON skus
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS skus;
DROP TABLE IF EXISTS products;
