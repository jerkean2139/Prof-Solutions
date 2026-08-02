import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { ownerSummary } from './service.js';

export function dashboardRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  // One read-only company-wide rollup for the owner dashboard.
  r.get(
    '/dashboard/summary',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await ownerSummary());
    }),
  );

  return r;
}
