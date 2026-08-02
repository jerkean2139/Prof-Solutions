import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import { badRequest } from '../../http/errors.js';
import { receiveStock, adjustStock, getOnHand, listWarehouses, listInventory } from './service.js';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal like 18.50');

// Either identifier resolves the SKU. The phone sends qrCode after a scan.
const skuRef = z
  .object({ skuId: z.string().uuid().optional(), qrCode: z.string().min(1).optional() })
  .refine((v) => v.skuId || v.qrCode, 'provide skuId or qrCode');

const receiveSchema = skuRef.and(
  z.object({
    warehouseId: z.string().uuid(),
    quantity: z.number().int().positive(),
    unitCost: money.optional(),
    lotCode: z.string().optional(),
    expiresOn: z.string().optional(),
    referenceType: z.enum(['purchase_order', 'manual']).optional(),
    referenceId: z.string().uuid().optional(),
  }),
);

const adjustSchema = skuRef.and(
  z.object({
    warehouseId: z.string().uuid(),
    delta: z.number().int().refine((n) => n !== 0, 'delta cannot be zero'),
    reason: z.string().min(1),
  }),
);

export function inventoryRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  // Inbound receiving. Scan -> quantity -> confirm.
  r.post(
    '/inventory/receive',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = receiveSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await receiveStock({ ...parsed.data, createdBy }));
    }),
  );

  // A correction with a required reason. Never edits history.
  r.post(
    '/inventory/adjust',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = adjustSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await adjustStock({ ...parsed.data, createdBy }));
    }),
  );

  // Whole-catalog stock position (on hand / committed / available per SKU).
  r.get(
    '/inventory',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listInventory());
    }),
  );

  // Active warehouses, for the receiving screen to target.
  r.get(
    '/warehouses',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listWarehouses());
    }),
  );

  // On-hand and available for a SKU, read from the snapshot cache.
  r.get(
    '/inventory/on-hand/:skuId',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getOnHand(req.params.skuId as string));
    }),
  );

  return r;
}
