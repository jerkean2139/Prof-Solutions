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

// A token verifier maps a bearer token to Clerk claims, or null if invalid.
// It is injectable so the enforced path can be tested without real Clerk keys,
// and so a different provider could be swapped in without touching callers.
export interface ClerkClaims {
  sub: string;
  org_id?: string;
}
export type TokenVerifier = (token: string) => Promise<ClerkClaims | null>;

// The default verifier loads @clerk/backend lazily so nothing needs real keys
// just to import this module.
const defaultVerify: TokenVerifier = async (token) => {
  const { verifyToken } = await import('@clerk/backend');
  try {
    const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    return { sub: claims.sub, org_id: claims.org_id as string | undefined };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'clerk token verification failed');
    return null;
  }
};

// Guards a route. With enforcement off it injects the mock identity; with it on
// it requires a valid bearer token. `enforced` and `verify` default to the real
// values and can be overridden (tests, alternate providers).
export function requireAuth(opts?: { enforced?: boolean; verify?: TokenVerifier }) {
  const enforced = opts?.enforced ?? env.AUTH_ENFORCED;
  const verify = opts?.verify ?? defaultVerify;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!enforced) {
      req.auth = MOCK_AUTH;
      next();
      return;
    }
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const claims = await verify(token);
    if (!claims) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.auth = { userId: claims.sub, orgId: claims.org_id ?? null, source: 'clerk' };
    next();
  };
}
