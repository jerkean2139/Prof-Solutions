import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { requireAuth } from '../../auth/clerk.js';
import { badRequest } from '../../http/errors.js';
import { describeSchema } from '../../agent/schema.js';
import { answerQuestion } from '../../agent/ask.js';
import { AgentNotConfiguredError } from '../../agent/planner.js';

// Phase 3 read-only ops agent HTTP surface. There is deliberately no raw-SQL
// endpoint: the agent runs only planner-produced SELECTs, and even those go
// through the guard and the read-only executor. Schema introspection is exposed
// because it is metadata (table and column names), never data.

const askSchema = z.object({ question: z.string().min(1) });

export function agentRoutes(): Router {
  const r = Router();
  r.use(requireAuth());

  r.get(
    '/agent/schema',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await describeSchema());
    }),
  );

  r.post(
    '/agent/query',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = askSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]!.message);
      try {
        res.json(await answerQuestion(parsed.data.question));
      } catch (err) {
        if (err instanceof AgentNotConfiguredError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    }),
  );

  return r;
}
