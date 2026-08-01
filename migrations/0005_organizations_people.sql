-- migrate:up

-- The fundraising teams. Schools, sports teams, churches, booster clubs.
CREATE TABLE organizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  org_type       text NOT NULL CHECK (org_type IN ('school', 'sports_team', 'church', 'other')),
  status         text NOT NULL DEFAULT 'prospect'
                 CHECK (status IN ('prospect', 'onboarding', 'active', 'dormant')),
  -- Contact identity is cached from GHL. GHL wins on conflict.
  contact_name   text,
  contact_email  text,
  contact_phone  text,
  ghl_contact_id text,
  -- The provisioned GHL store (funnel) and its stable public slug.
  ghl_store_id   text,
  store_slug     text UNIQUE,
  -- Clerk org identity for the portal. Nullable until enforcement flips on.
  clerk_org_id   text,
  address_line1  text,
  address_line2  text,
  address_city   text,
  address_state  text,
  address_postal text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  deleted_at     timestamptz
);

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What a team agreed to at onboarding, frozen, so nothing surprises them later.
CREATE TABLE organization_agreements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  terms_version   text NOT NULL,
  terms_snapshot  text NOT NULL,
  accepted_by     text NOT NULL,
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz
);

CREATE TRIGGER organization_agreements_set_updated_at
  BEFORE UPDATE ON organization_agreements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Reps: recruited from the community to represent the product and the
-- fundraising opportunity. They bring teams on board (the distributor layer).
CREATE TABLE reps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GHL is the source of truth for identity. A rep cannot exist without it.
  ghl_contact_id     text UNIQUE NOT NULL,
  display_name       text,
  status             text NOT NULL DEFAULT 'applicant'
                     CHECK (status IN ('applicant', 'approved', 'active', 'paused', 'terminated')),
  approved_at        timestamptz,
  starter_kit_sent_at timestamptz,
  commission_plan_id uuid REFERENCES commission_plans(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  deleted_at         timestamptz
);

CREATE INDEX idx_reps_ghl_contact_id ON reps(ghl_contact_id);

CREATE TRIGGER reps_set_updated_at
  BEFORE UPDATE ON reps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sellers: team players and parents who sell to the end buyer inside one team.
-- Distinct from reps. Never merged.
CREATE TABLE sellers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ghl_contact_id  text UNIQUE NOT NULL,
  display_name    text,
  -- Rides the store link, lands on the order as seller credit.
  seller_code     text UNIQUE NOT NULL,
  status          text NOT NULL DEFAULT 'applicant'
                  CHECK (status IN ('applicant', 'approved', 'active', 'paused')),
  clerk_user_id   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz
);

CREATE INDEX idx_sellers_ghl_contact_id ON sellers(ghl_contact_id);
CREATE INDEX idx_sellers_organization_id ON sellers(organization_id);

CREATE TRIGGER sellers_set_updated_at
  BEFORE UPDATE ON sellers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Customers: end buyers. The master Profitable Solutions client list.
CREATE TABLE customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GHL owns identity, created at checkout. Linked here.
  ghl_contact_id text UNIQUE NOT NULL,
  display_name   text,
  email          text,
  phone          text,
  first_order_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  deleted_at     timestamptz
);

CREATE INDEX idx_customers_ghl_contact_id ON customers(ghl_contact_id);

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Rolls a customer up to each team they bought through. The team sees its own
-- list, Profitable Solutions sees the master list of all customers.
CREATE TABLE organization_customers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  first_order_at  timestamptz,
  last_order_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  UNIQUE (organization_id, customer_id)
);

CREATE INDEX idx_org_customers_organization_id ON organization_customers(organization_id);
CREATE INDEX idx_org_customers_customer_id ON organization_customers(customer_id);

CREATE TRIGGER organization_customers_set_updated_at
  BEFORE UPDATE ON organization_customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS organization_customers;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS sellers;
DROP TABLE IF EXISTS reps;
DROP TABLE IF EXISTS organization_agreements;
DROP TABLE IF EXISTS organizations;
