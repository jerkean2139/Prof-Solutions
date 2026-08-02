import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import { badRequest } from '../../http/errors.js';
import {
  createVendor,
  listVendors,
  createPurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  receivePurchaseOrder,
} from './service.js';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal like 18.50');

const vendorSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  paymentTerms: z.string().optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
});

const poSchema = z.object({
  vendorId: z.string().uuid(),
  lines: z
    .array(z.object({ skuId: z.string().uuid(), quantityOrdered: z.number().int().positive(), unitCost: money }))
    .min(1),
});

const receiveSchema = z.object({
  receipts: z
    .array(z.object({ poLineId: z.string().uuid(), quantity: z.number().int().positive(), warehouseId: z.string().uuid().optional() }))
    .min(1),
});

export function vendorRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  r.post(
    '/vendors',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = vendorSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await createVendor({ ...parsed.data, createdBy }));
    }),
  );

  r.get(
    '/vendors',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listVendors());
    }),
  );

  r.post(
    '/purchase-orders',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = poSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await createPurchaseOrder({ ...parsed.data, createdBy }));
    }),
  );

  r.get(
    '/purchase-orders',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listPurchaseOrders());
    }),
  );

  r.get(
    '/purchase-orders/:id',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getPurchaseOrder(req.params.id as string));
    }),
  );

  r.post(
    '/purchase-orders/:id/receive',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = receiveSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.json(await receivePurchaseOrder(req.params.id as string, { ...parsed.data, createdBy }));
    }),
  );

  return r;
}
