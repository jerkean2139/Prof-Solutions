import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import {
  settleSale,
  getSettlement,
  approveCommission,
  payCommission,
  listCommissions,
} from './service.js';

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

  // Commission payout run: list, approve, pay.
  r.get(
    '/commissions',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(
        await listCommissions({
          payeeType: req.query.payeeType ? String(req.query.payeeType) : undefined,
          payeeId: req.query.payeeId ? String(req.query.payeeId) : undefined,
          status: req.query.status ? String(req.query.status) : undefined,
        }),
      );
    }),
  );

  r.post(
    '/commissions/:id/approve',
    asyncHandler(async (req: Request, res: Response) => {
      const approvedBy = await resolveInternalUserId(req.auth);
      res.json(await approveCommission(req.params.id as string, approvedBy));
    }),
  );

  r.post(
    '/commissions/:id/pay',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await payCommission(req.params.id as string));
    }),
  );

  return r;
}

