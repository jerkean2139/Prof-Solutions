import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import { badRequest } from '../../http/errors.js';
import { createOrder, getOrder, listOrders } from './service.js';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal like 135.00');

// Shared order shape for both staff entry and the online webhook.
export const orderInputSchema = z.object({
  campaignId: z.string().uuid(),
  buyer: z.object({
    ghlContactId: z.string().min(1),
    displayName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  }),
  sellerCode: z.string().optional(),
  entryChannel: z.enum(['online', 'paper', 'phone']),
  lines: z.array(z.object({ skuId: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
  orderNumber: z.string().optional(),
  payment: z
    .object({
      amount: money,
      status: z
        .enum(['pending', 'authorized', 'captured', 'settled', 'failed', 'refunded'])
        .optional(),
      acceptBlueRef: z.string().optional(),
      ghlTransactionId: z.string().optional(),
    })
    .optional(),
});

export function orderRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  // Staff paper/phone entry. The online path comes through the GHL webhook.
  r.post(
    '/orders',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = orderInputSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await createOrder({ ...parsed.data, createdBy }));
    }),
  );

  r.get(
    '/orders/:id',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getOrder(req.params.id as string));
    }),
  );

  // Order history for a sale.
  r.get(
    '/sales/:id/orders',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await listOrders(req.params.id as string));
    }),
  );

  return r;
}
