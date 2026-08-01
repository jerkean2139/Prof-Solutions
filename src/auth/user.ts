import type { AuthContext } from './clerk.js';
import { pool } from '../db/pool.js';

// Maps an auth context to an internal users.id (a uuid) for audit columns like
// created_by. GHL and Clerk identities are external; created_by references the
// internal users table.
//
// In mock mode (enforcement off) there is no real signed-in staff user, so this
// returns null and the audit column stays null. That is allowed: created_by is
// nullable until Clerk enforcement and user provisioning land. When enforced,
// the Clerk subject is matched to users.clerk_user_id.
export async function resolveInternalUserId(
  auth: AuthContext | undefined,
): Promise<string | null> {
  if (!auth || auth.source === 'mock') return null;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE clerk_user_id = $1 AND deleted_at IS NULL`,
    [auth.userId],
  );
  return rows[0]?.id ?? null;
}
