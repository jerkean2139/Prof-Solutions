import { pool } from '../../db/pool.js';
import { notFound, conflict } from '../../http/errors.js';

// Products and SKUs. This is the catalog the GHL store is fed from and the
// thing the phone scanner resolves against. Money stays a string end to end so
// it never becomes a float.

export interface CreateProductInput {
  name: string;
  brand: string;
  category: 'detergent' | 'candle' | 'topical';
  ownerEntity: string;
  createdBy: string | null;
}

export interface CreateSkuInput {
  productId: string;
  skuCode: string;
  description?: string;
  unitConfig?: string;
  retailPrice?: string; // defaults to 45.00 in the database
  productCost?: string;
  barcode?: string;
  qrCode?: string;
  createdBy: string | null;
}

export async function createProduct(input: CreateProductInput) {
  const { rows } = await pool.query(
    `INSERT INTO products (name, brand, category, owner_entity, created_by)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, brand, category, owner_entity, active, created_at`,
    [input.name, input.brand, input.category, input.ownerEntity, input.createdBy],
  );
  return rows[0];
}

export async function listProducts() {
  const { rows } = await pool.query(
    `SELECT id, name, brand, category, owner_entity, active, created_at
       FROM products
      WHERE deleted_at IS NULL
      ORDER BY name`,
  );
  return rows;
}

export async function createSku(input: CreateSkuInput) {
  const product = await pool.query(`SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL`, [
    input.productId,
  ]);
  if (product.rowCount === 0) throw notFound(`product ${input.productId} not found`);

  try {
    const { rows } = await pool.query(
      `INSERT INTO skus (product_id, sku_code, description, unit_config, retail_price, product_cost, barcode, qr_code, created_by)
       VALUES ($1,$2,$3,$4, COALESCE($5, 45.00), $6, $7, $8, $9)
       RETURNING id, product_id, sku_code, description, unit_config, retail_price, product_cost, barcode, qr_code, active`,
      [
        input.productId,
        input.skuCode,
        input.description ?? null,
        input.unitConfig ?? null,
        input.retailPrice ?? null,
        input.productCost ?? null,
        input.barcode ?? null,
        input.qrCode ?? null,
        input.createdBy,
      ],
    );
    return rows[0];
  } catch (err) {
    // Unique violation on sku_code or qr_code.
    if ((err as { code?: string }).code === '23505') {
      throw conflict(`sku_code or qr_code already exists`);
    }
    throw err;
  }
}

export async function listSkus() {
  const { rows } = await pool.query(
    `SELECT s.id, s.product_id, s.sku_code, p.name AS product_name,
            s.description, s.unit_config, s.retail_price, s.product_cost,
            s.barcode, s.qr_code, s.active
       FROM skus s
       JOIN products p ON p.id = s.product_id
      WHERE s.deleted_at IS NULL
      ORDER BY s.sku_code`,
  );
  return rows;
}

export async function getSku(id: string) {
  const { rows } = await pool.query(
    `SELECT id, product_id, sku_code, description, unit_config, retail_price, product_cost, barcode, qr_code, active
       FROM skus WHERE id=$1 AND deleted_at IS NULL`,
    [id],
  );
  if (rows.length === 0) throw notFound(`sku ${id} not found`);
  return rows[0];
}

// The scan path. Resolves a QR code to a SKU. This is the single most latency-
// sensitive read in receiving, and it hits the qr_code index.
export async function resolveSkuByQr(qrCode: string) {
  const { rows } = await pool.query(
    `SELECT id, product_id, sku_code, description, unit_config, retail_price, qr_code, active
       FROM skus WHERE qr_code=$1 AND deleted_at IS NULL`,
    [qrCode],
  );
  if (rows.length === 0) throw notFound(`no SKU for QR code ${qrCode}`);
  return rows[0];
}
