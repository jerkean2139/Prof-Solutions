import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { badRequest } from '../../http/errors.js';
import { marginReport, sellerLeaderboard } from './service.js';

export function reportRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  // Margin split by owner_entity and channel. Optional filters narrow it.
  r.get(
    '/reports/margin',
    asyncHandler(async (req: Request, res: Response) => {
      const ownerEntity = req.query.ownerEntity ? String(req.query.ownerEntity) : undefined;
      const channel = req.query.channel ? String(req.query.channel) : undefined;
      res.json(await marginReport({ ownerEntity, channel }));
    }),
  );

  // Seller leaderboard, scoped to an organization (and optionally one sale).
  r.get(
    '/reports/leaderboard',
    asyncHandler(async (req: Request, res: Response) => {
      const organizationId = req.query.organizationId ? String(req.query.organizationId) : undefined;
      const campaignId = req.query.campaignId ? String(req.query.campaignId) : undefined;
      if (organizationId && !z.string().uuid().safeParse(organizationId).success) {
        throw badRequest('organizationId must be a uuid');
      }
      res.json(await sellerLeaderboard({ organizationId, campaignId }));
    }),
  );

  return r;
}
