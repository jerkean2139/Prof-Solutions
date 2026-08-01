import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { rebuildForecasts, listForecasts, reorderList } from './service.js';

export function forecastRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  // Recompute forecasts from order history.
  r.post(
    '/forecast/rebuild',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await rebuildForecasts());
    }),
  );

  r.get(
    '/forecast',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listForecasts());
    }),
  );

  // What to reorder now, with a suggested quantity.
  r.get(
    '/inventory/reorder',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await reorderList());
    }),
  );

  return r;
}
