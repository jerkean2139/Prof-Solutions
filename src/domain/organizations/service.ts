import { pool, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import { emitGhlEvent } from '../../integrations/ghl/outbound.js';

// Team onboarding. A group registers to sell, agrees to the terms up front, and
// gets a store provisioned. The organization contact identity lives in GHL and
// is linked by ghl_contact_id; we cache name/email/phone for reporting speed.

export interface RegisterTeamInput {
  name: string;
  orgType: 'school' | 'sports_team' | 'church' | 'other';
  ghlContactId: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  storeSlug: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postal?: string;
  };
  agreement: {
    termsVersion: string;
    termsSnapshot: string;
    acceptedBy: string;
  };
  createdBy: string | null;
}

// Registers a team, records the agreement, and provisions the GHL store. All in
// one transaction so a team never exists without an accepted agreement.
export async function registerTeam(input: RegisterTeamInput) {
  const org = await withTransaction(async (client) => {
    let created;
    try {
      const { rows } = await client.query(
        `INSERT INTO organizations
           (name, org_type, status, contact_name, contact_email, contact_phone,
            ghl_contact_id, store_slug, address_line1, address_line2, address_city,
            address_state, address_postal, created_by)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, name, org_type, status, store_slug, ghl_contact_id`,
        [
          input.name,
          input.orgType,
          input.contactName ?? null,
          input.contactEmail ?? null,
          input.contactPhone ?? null,
          input.ghlContactId,
          input.storeSlug,
          input.address?.line1 ?? null,
          input.address?.line2 ?? null,
          input.address?.city ?? null,
          input.address?.state ?? null,
          input.address?.postal ?? null,
          input.createdBy,
        ],
      );
      created = rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('store_slug already in use');
      }
      throw err;
    }

    await client.query(
      `INSERT INTO organization_agreements
         (organization_id, terms_version, terms_snapshot, accepted_by, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        created.id,
        input.agreement.termsVersion,
        input.agreement.termsSnapshot,
        input.agreement.acceptedBy,
        input.createdBy,
      ],
    );
    return created;
  });

  // Provision the team store (a GHL funnel) and seed the catalog. Queued, never
  // inline: the store build must not block onboarding from completing.
  await emitGhlEvent('store.provision', {
    targetId: org.ghl_contact_id,
    tags: ['team-onboarded'],
    payload: { organizationId: org.id, storeSlug: org.store_slug },
  });

  return org;
}

export async function listOrganizations() {
  const { rows } = await pool.query(
    `SELECT id, name, org_type, status, store_slug, ghl_contact_id, created_at
       FROM organizations WHERE deleted_at IS NULL ORDER BY name`,
  );
  return rows;
}

export async function getOrganization(id: string) {
  const { rows } = await pool.query(
    `SELECT id, name, org_type, status, store_slug, ghl_contact_id, contact_name,
            contact_email, contact_phone, created_at
       FROM organizations WHERE id=$1 AND deleted_at IS NULL`,
    [id],
  );
  if (rows.length === 0) throw notFound(`organization ${id} not found`);
  return rows[0];
}

export interface AddSellerInput {
  organizationId: string;
  ghlContactId: string;
  displayName?: string;
  sellerCode: string;
  createdBy: string | null;
}

// A seller is a team player or parent who sells to buyers. Their seller_code
// rides the store link and lands on the order as credit.
export async function addSeller(input: AddSellerInput) {
  const org = await pool.query(`SELECT id FROM organizations WHERE id=$1 AND deleted_at IS NULL`, [
    input.organizationId,
  ]);
  if (org.rowCount === 0) throw notFound(`organization ${input.organizationId} not found`);

  try {
    const { rows } = await pool.query(
      `INSERT INTO sellers (organization_id, ghl_contact_id, display_name, seller_code, status, created_by)
       VALUES ($1,$2,$3,$4,'active',$5)
       RETURNING id, organization_id, display_name, seller_code, status`,
      [input.organizationId, input.ghlContactId, input.displayName ?? null, input.sellerCode, input.createdBy],
    );
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw conflict('seller_code or ghl_contact_id already exists');
    }
    throw err;
  }
}

export async function listSellers(organizationId: string) {
  if (!organizationId) throw badRequest('organizationId is required');
  const { rows } = await pool.query(
    `SELECT id, display_name, seller_code, status
       FROM sellers WHERE organization_id=$1 AND deleted_at IS NULL ORDER BY seller_code`,
    [organizationId],
  );
  return rows;
}

// The team's own customer base: every buyer who ordered through this org, with
// when they first and last bought. This is the org portal's customer view, and
// it rolls up (through all orgs) into the master Profitable Solutions list.
export async function listOrgCustomers(organizationId: string) {
  if (!organizationId) throw badRequest('organizationId is required');
  const { rows } = await pool.query(
    `SELECT c.id, c.display_name, c.email, c.phone, c.ghl_contact_id,
            oc.first_order_at, oc.last_order_at
       FROM organization_customers oc
       JOIN customers c ON c.id = oc.customer_id AND c.deleted_at IS NULL
      WHERE oc.organization_id = $1 AND oc.deleted_at IS NULL
      ORDER BY oc.last_order_at DESC NULLS LAST`,
    [organizationId],
  );
  return rows;
}
