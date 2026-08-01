import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireAuth, type TokenVerifier } from '../src/auth/clerk.js';

// Exercises the Clerk enforcement path without real keys by injecting a
// verifier. This proves that flipping AUTH_ENFORCED on will reject missing or
// invalid tokens and pass valid ones through.

function fakeReq(authHeader?: string): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? authHeader : undefined,
  } as unknown as Request;
}

function fakeRes() {
  const res: { statusCode?: number; body?: unknown } = {};
  const r = {
    status(code: number) {
      res.statusCode = code;
      return r;
    },
    json(body: unknown) {
      res.body = body;
      return r;
    },
  };
  return { res, r: r as unknown as Response };
}

describe('auth boundary', () => {
  it('injects a mock identity when enforcement is off', async () => {
    const req = fakeReq();
    const { r } = fakeRes();
    const next = vi.fn();
    await requireAuth({ enforced: false })(req, r, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth?.source).toBe('mock');
  });

  it('401s an enforced request with no token', async () => {
    const req = fakeReq();
    const { res, r } = fakeRes();
    const next = vi.fn();
    await requireAuth({ enforced: true, verify: async () => ({ sub: 'x' }) })(req, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('401s an enforced request whose token fails verification', async () => {
    const verify: TokenVerifier = async () => null;
    const req = fakeReq('Bearer bad-token');
    const { res, r } = fakeRes();
    const next = vi.fn();
    await requireAuth({ enforced: true, verify })(req, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('passes an enforced request with a valid token and sets the clerk identity', async () => {
    const verify: TokenVerifier = async (token) =>
      token === 'good' ? { sub: 'user_123', org_id: 'org_9' } : null;
    const req = fakeReq('Bearer good');
    const { r } = fakeRes();
    const next = vi.fn();
    await requireAuth({ enforced: true, verify })(req, r, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toEqual({ userId: 'user_123', orgId: 'org_9', source: 'clerk' });
  });
});
