-- migrate:up

-- Internal staff. Created first so created_by can reference it everywhere.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'warehouse', 'sales', 'readonly')),
  -- Clerk governs login. Wired now, nullable until enforcement flips on.
  clerk_user_id text UNIQUE,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Self-referential and nullable so the first (bootstrap) user can exist.
  created_by    uuid REFERENCES users(id),
  deleted_at    timestamptz
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down
DROP TABLE IF EXISTS users;
