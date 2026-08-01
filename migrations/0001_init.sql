-- migrate:up

-- gen_random_uuid() is built into Postgres 16 core, but pgcrypto is harmless
-- and keeps older environments happy.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Rule 5: every table gets created_at, updated_at, created_by. This function
-- keeps updated_at honest on every UPDATE. Each table attaches a trigger to it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- migrate:down
DROP FUNCTION IF EXISTS set_updated_at();
DROP EXTENSION IF EXISTS pgcrypto;
