import { pool } from '../../db/pool.js';

// The master Profitable Solutions client list: every buyer across every team,
// deduped to one row per person, with how many teams they have ordered through
// and their most recent order. This is the rollup the business model is built
// around -- each team's list feeds this one. Read-only; the custom stack owns
// the customer operational record (GHL owns contact identity).

export async function listMasterCustomers() {
  const { rows } = await pool.query(
    `SELECT c.id, c.display_name, c.email, c.phone,
            COUNT(DISTINCT oc.organization_id)::int AS teams,
            MIN(oc.first_order_at) AS first_order_at,
            MAX(oc.last_order_at) AS last_order_at
       FROM customers c
       LEFT JOIN organization_customers oc
         ON oc.customer_id = c.id AND oc.deleted_at IS NULL
      WHERE c.deleted_at IS NULL
      GROUP BY c.id, c.display_name, c.email, c.phone
      ORDER BY MAX(oc.last_order_at) DESC NULLS LAST, c.display_name`,
  );
  return rows;
}
