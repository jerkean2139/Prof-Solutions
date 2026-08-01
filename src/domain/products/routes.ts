import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import { badRequest } from '../../http/errors.js';
import {
  createProduct,
  listProducts,
  createSku,
  listSkus,
  getSku,
  resolveSkuByQr,
} from './service.js';

// Money is accepted as a string and validated as a decimal, never parsed to a
// float on the way in.
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal like 45.00');

const productSchema = z.object({
  name: z.string().min(1),
  brand: z.string().min(1),
  category: z.enum(['detergent', 'candle', 'topical']),
  ownerEntity: z.string().min(1),
});

const skuSchema = z.object({
  productId: z.string().uuid(),
  skuCode: z.string().min(1),
  description: z.string().optional(),
  unitConfig: z.string().optional(),
  retailPrice: money.optional(),
  productCost: money.optional(),
  barcode: z.string().optional(),
  qrCode: z.string().optional(),
});

export function productRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  r.get(
    '/products',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listProducts());
    }),
  );

  r.post(
    '/products',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await createProduct({ ...parsed.data, createdBy }));
    }),
  );

  // Scan resolution. Query param so the phone can hit it directly after a scan.
  r.get(
    '/skus/resolve',
    asyncHandler(async (req: Request, res: Response) => {
      const qr = z.string().min(1).safeParse(req.query.qr);
      if (!qr.success) throw badRequest('qr query param is required');
      res.json(await resolveSkuByQr(qr.data));
    }),
  );

  r.get(
    '/skus',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listSkus());
    }),
  );

  r.get(
    '/skus/:id',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getSku(req.params.id as string));
    }),
  );

  r.post(
    '/skus',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = skuSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await createSku({ ...parsed.data, createdBy }));
    }),
  );

  return r;
}
