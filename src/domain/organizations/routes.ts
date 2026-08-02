import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { resolveInternalUserId } from '../../auth/user.js';
import { badRequest } from '../../http/errors.js';
import {
  registerTeam,
  listOrganizations,
  getOrganization,
  addSeller,
  listSellers,
  listOrgCustomers,
} from './service.js';

const registerSchema = z.object({
  name: z.string().min(1),
  orgType: z.enum(['school', 'sports_team', 'church', 'other']),
  ghlContactId: z.string().min(1),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  storeSlug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes'),
  address: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postal: z.string().optional(),
    })
    .optional(),
  agreement: z.object({
    termsVersion: z.string().min(1),
    termsSnapshot: z.string().min(1),
    acceptedBy: z.string().min(1),
  }),
});

const sellerSchema = z.object({
  ghlContactId: z.string().min(1),
  displayName: z.string().optional(),
  sellerCode: z.string().min(1),
});

export function organizationRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  r.post(
    '/organizations',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(await registerTeam({ ...parsed.data, createdBy }));
    }),
  );

  r.get(
    '/organizations',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await listOrganizations());
    }),
  );

  r.get(
    '/organizations/:id',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await getOrganization(req.params.id as string));
    }),
  );

  r.post(
    '/organizations/:id/sellers',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = sellerSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      const createdBy = await resolveInternalUserId(req.auth);
      res.status(201).json(
        await addSeller({ ...parsed.data, organizationId: req.params.id as string, createdBy }),
      );
    }),
  );

  r.get(
    '/organizations/:id/sellers',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await listSellers(req.params.id as string));
    }),
  );

  // The team's customer base view.
  r.get(
    '/organizations/:id/customers',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await listOrgCustomers(req.params.id as string));
    }),
  );

  return r;
}
