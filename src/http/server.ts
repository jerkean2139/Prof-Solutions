import express, { type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { requireAuth } from '../auth/clerk.js';
import { verifyWebhookSignature } from '../integrations/acceptblue/payments.js';
import { pool } from '../db/pool.js';

// Phase 0 HTTP surface: a health check, the auth boundary wired but not
// enforced, and webhook intake stubs. No business endpoints yet. The point is
// that the boundaries exist and are exercised before Phase 1 fills them in.

export function createServer() {
  const app = express();

  // Capture the raw body for webhook signature verification, but still parse
  // JSON for normal routes.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up', authEnforced: env.AUTH_ENFORCED });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'health check db failure');
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Accept Blue / GHL payment webhook. Verifies the signature, then would
  // record or update a payment reference. Never accepts raw bank data.
  app.post('/webhooks/accept-blue', (req: Request, res: Response) => {
    const raw = (req as Request & { rawBody?: string }).rawBody ?? '';
    const signature = req.header('x-acceptblue-signature') ?? '';
    if (!verifyWebhookSignature(raw, signature)) {
      res.status(401).json({ error: 'bad signature' });
      return;
    }
    logger.info('accept-blue webhook accepted (Phase 0 stub)');
    res.json({ received: true });
  });

  // GHL inbound webhook (store orders, contact updates). Phase 1 wires the
  // handlers that create orders and customers.
  app.post('/webhooks/ghl', (_req: Request, res: Response) => {
    logger.info('ghl webhook accepted (Phase 0 stub)');
    res.json({ received: true });
  });

  // Example of a protected route. With AUTH_ENFORCED=false it injects a mock
  // identity; with it on, Clerk verifies the session.
  app.get('/me', requireAuth(), (req: Request, res: Response) => {
    res.json({ auth: req.auth });
  });

  return app;
}

// Only listen when run directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createServer();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, authEnforced: env.AUTH_ENFORCED }, 'server listening');
  });
}
