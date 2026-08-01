import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import { settleSale, getSettlement } from './service.js';

export function settlementRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  // Settle a delivered sale: compute payouts from the locked plan and accrue
  // commissions.
  r.post(
    '/sales/:id/settle',
    asyncHandler(async (req: Request, res: Response) => {
      const settledBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await settleSale(req.params.id as string, settledBy));
    }),
  );

  r.get(
    '/sales/:id/settlement',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getSettlement(req.params.id as string));
    }),
  );

  return r;
}
