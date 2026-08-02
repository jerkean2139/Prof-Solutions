import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import { badRequest } from '../../http/errors.js';
import {
  generatePickList,
  getPickListForSale,
  pickLine,
  completePickList,
  createShipment,
  getPackingSlip,
} from './service.js';

const pickSchema = z.object({
  quantityPicked: z.number().int().positive(),
  lotId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
});

const shipSchema = z.object({
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
});

export function fulfillmentRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  // Generate the bulk pick list for a finalized sale.
  r.post(
    '/sales/:id/pick-list',
    asyncHandler(async (req: Request, res: Response) => {
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await generatePickList(req.params.id as string, createdBy));
    }),
  );

  // Read the current pick list for a sale (so the picking screen survives a
  // reload). Returns null when none has been generated yet.
  r.get(
    '/sales/:id/pick-list',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getPickListForSale(req.params.id as string));
    }),
  );

  // Complete a pick line (writes the pick transaction to the ledger).
  r.post(
    '/pick-list-lines/:id/pick',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = pickSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const pickedBy = await resolveInternalUserId(req.auth);
      res.json(await pickLine(req.params.id as string, { ...parsed.data, pickedBy }));
    }),
  );

  r.post(
    '/pick-lists/:id/complete',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await completePickList(req.params.id as string));
    }),
  );

  // Ship one bulk delivery to the team.
  r.post(
    '/pick-lists/:id/ship',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = shipSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await createShipment(req.params.id as string, { ...parsed.data, createdBy }));
    }),
  );

  // The packing slip document.
  r.get(
    '/pick-lists/:id/packing-slip',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getPackingSlip(req.params.id as string));
    }),
  );

  return r;
}
