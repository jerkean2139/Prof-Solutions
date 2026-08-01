-- migrate:up

-- A team's fundraising sale. Org-facing word is "sale". The close is
-- group-triggered (the team finalizes in their portal), not a calendar deadline.
CREATE TABLE campaigns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  rep_id               uuid REFERENCES reps(id),
  name                 text NOT NULL,
  -- Model the channel now so retail and fundraising never blend in reporting.
  channel              text NOT NULL DEFAULT 'fundraising'
                       CHECK (channel IN ('fundraising', 'retail')),
  -- Plan is locked at sale creation. A later rate change does not move it.
  commission_plan_id   uuid NOT NULL REFERENCES commission_plans(id),
  starts_on            date,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'open', 'finalizing', 'finalized',
                                         'picking', 'delivered', 'settled', 'cancelled')),
  finalized_at         timestamptz,
  finalized_by         text,
  goal_amount          numeric(12,2),
  -- Growth loop: countdown target and incentive shown in the portal.
  next_sale_target     date,
  incentive_note       text,
  delivery_target_date date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  deleted_at           timestamptz
);

CREATE INDEX idx_campaigns_status_org ON campaigns(status, organization_id);

CREATE TRIGGER campaigns_set_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which products are offered in this sale, with optional price override.
CREATE TABLE campaign_skus (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id),
  sku_id         uuid NOT NULL REFERENCES skus(id),
  -- null means use sku.retail_price.
  price_override numeric(12,2),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  deleted_at     timestamptz,
  UNIQUE (campaign_id, sku_id)
);

CREATE TRIGGER campaign_skus_set_updated_at
  BEFORE UPDATE ON campaign_skus
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS campaign_skus;
DROP TABLE IF EXISTS campaigns;
