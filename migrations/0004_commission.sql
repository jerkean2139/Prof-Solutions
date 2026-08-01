-- migrate:up

-- Rule 3: commission values live in config, never in code. Versioned by date
-- so a historical sale settles at the rate that applied when it ran.
CREATE TABLE commission_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  deleted_at     timestamptz
);

CREATE TRIGGER commission_plans_set_updated_at
  BEFORE UPDATE ON commission_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE commission_plan_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                uuid NOT NULL REFERENCES commission_plans(id),
  -- organization: flat per unit. distributor (rep): percent of retail.
  -- seller: defined now so per-seller payout is a config row in Phase 2.
  payee_role             text NOT NULL CHECK (payee_role IN ('organization', 'distributor', 'seller')),
  calc_type              text NOT NULL CHECK (calc_type IN ('flat_per_unit', 'percent_of_retail')),
  -- 12.00 flat, or 0.1250 percent. Four decimals to hold a precise rate.
  value                  numeric(12,4) NOT NULL CHECK (value > 0),
  applies_to_product_id  uuid REFERENCES products(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users(id),
  deleted_at             timestamptz
);

CREATE TRIGGER commission_plan_lines_set_updated_at
  BEFORE UPDATE ON commission_plan_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS commission_plan_lines;
DROP TABLE IF EXISTS commission_plans;
