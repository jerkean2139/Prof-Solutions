import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

// Clerk is the identity boundary (rule 9). It is wired in now and enforced
// later: dev and test run on mock data with AUTH_ENFORCED=false. When the flag
// flips on, this middleware verifies a real Clerk session and nothing else in
// the app changes.
//
// GHL identity and Clerk identity are separate systems for separate jobs. This
// governs who can log into the portal and app, not contact records.

export interface AuthContext {
  userId: string;
  orgId: string | null;
  // 'mock' until enforcement is on, then 'clerk'.
  source: 'mock' | 'clerk';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

const MOCK_AUTH: AuthContext = {
  userId: '00000000-0000-0000-0000-000000000000',
  orgId: null,
  source: 'mock',
};

// Enforced verification is loaded lazily so tests and Phase 0 never need real
// Clerk keys just to import this module.
async function verifyClerkSession(req: Request): Promise<AuthContext | null> {
  const { verifyToken } = await import('@clerk/backend');
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    return {
      userId: claims.sub,
      orgId: (claims.org_id as string | undefined) ?? null,
      source: 'clerk',
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'clerk token verification failed');
    return null;
  }
}

export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!env.AUTH_ENFORCED) {
      req.auth = MOCK_AUTH;
      next();
      return;
    }
    const ctx = await verifyClerkSession(req);
    if (!ctx) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.auth = ctx;
    next();
  };
}
