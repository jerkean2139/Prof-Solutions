import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, wipeDomain } from './helpers.js';
import {
  createProduct,
  createSku,
  resolveSkuByQr,
  listSkus,
} from '../src/domain/products/service.js';

describe('products and SKUs', () => {
  beforeAll(async () => {
    await ensureMigrated();
    await wipeDomain();
  });

  it('creates a product and a SKU, defaulting price to 45.00', async () => {
    const product = await createProduct({
      name: 'Laundry Detergent',
      brand: 'Profitable Solutions',
      category: 'detergent',
      ownerEntity: 'profitable_solutions',
      createdBy: null,
    });
    const sku = await createSku({
      productId: product.id,
      skuCode: 'DET-5GAL',
      qrCode: 'QR-DET-5GAL',
      createdBy: null,
    });
    // NUMERIC comes back as a string, never a float.
    expect(sku.retail_price).toBe('45.00');
    expect((await listSkus()).length).toBe(1);
  });

  it('resolves a SKU by its QR code', async () => {
    const resolved = await resolveSkuByQr('QR-DET-5GAL');
    expect(resolved.sku_code).toBe('DET-5GAL');
  });

  it('404s an unknown QR code', async () => {
    await expect(resolveSkuByQr('QR-NOPE')).rejects.toMatchObject({ status: 404 });
  });

  it('conflicts on a duplicate sku_code', async () => {
    const product = await createProduct({
      name: 'X',
      brand: 'B',
      category: 'candle',
      ownerEntity: 'legacy',
      createdBy: null,
    });
    await expect(
      createSku({ productId: product.id, skuCode: 'DET-5GAL', createdBy: null }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
