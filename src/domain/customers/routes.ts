import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { listMasterCustomers } from './service.js';

export function customerRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  // The master client list across all teams.
  r.get(
    '/customers',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listMasterCustomers());
    }),
  );

  return r;
}
