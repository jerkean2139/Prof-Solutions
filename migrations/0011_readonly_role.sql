-- migrate:up
-- Rule 10: the Phase 3 ops AI agent gets a read-only Postgres role. It never
-- writes inventory, or anything else. This role has SELECT and nothing more.
--
-- A Postgres role is cluster-scoped, not database-scoped, so everything here is
-- written to be idempotent: creating the role only if absent, and granting
-- privileges that are safe to re-apply. The read-only agent executor switches
-- into this role (SET LOCAL ROLE) inside a READ ONLY transaction, so a query is
-- blocked from writing two ways: it lacks the privilege, and the transaction
-- forbids it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'profsol_readonly') THEN
    CREATE ROLE profsol_readonly NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO profsol_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO profsol_readonly;
-- Future tables created in this schema are readable by the agent automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO profsol_readonly;

-- The connecting user must be a member of the role to SET LOCAL ROLE into it.
-- Role membership is cluster-wide; granting again is a no-op.
DO $$
BEGIN
  EXECUTE format('GRANT profsol_readonly TO %I', current_user);
END $$;

-- migrate:down
-- Reverse every privilege granted above. The role itself is cluster-scoped and
-- may be referenced from another database; drop it only if nothing depends on
-- it, and otherwise leave an empty, privilege-less role behind rather than fail.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'profsol_readonly') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM profsol_readonly;
    EXECUTE format('REVOKE profsol_readonly FROM %I', current_user);
    -- Removes all remaining privileges granted to the role in this database.
    DROP OWNED BY profsol_readonly;
    BEGIN
      DROP ROLE profsol_readonly;
    EXCEPTION WHEN OTHERS THEN
      -- Still referenced elsewhere in the cluster; the role is now harmless.
      NULL;
    END;
  END IF;
END $$;
