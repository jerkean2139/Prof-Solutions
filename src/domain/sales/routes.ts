import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import { badRequest } from '../../http/errors.js';
import { createSale, openSale, getSale, finalizeSale } from './service.js';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal like 5000.00');

const createSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1),
  repId: z.string().uuid().optional(),
  commissionPlanId: z.string().uuid().optional(),
  channel: z.enum(['fundraising', 'retail']).optional(),
  startsOn: z.string().optional(),
  goalAmount: money.optional(),
  skus: z
    .array(z.object({ skuId: z.string().uuid(), priceOverride: money.optional() }))
    .min(1),
});

const finalizeSchema = z.object({
  finalizedBy: z.string().min(1),
  nextSaleTarget: z.string().optional(),
  incentiveNote: z.string().optional(),
});

export function salesRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  r.post(
    '/sales',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await createSale({ ...parsed.data, createdBy }));
    }),
  );

  r.get(
    '/sales/:id',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getSale(req.params.id as string));
    }),
  );

  r.post(
    '/sales/:id/open',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await openSale(req.params.id as string));
    }),
  );

  r.post(
    '/sales/:id/finalize',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = finalizeSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      res.json(await finalizeSale(req.params.id as string, parsed.data));
    }),
  );

  return r;
}
