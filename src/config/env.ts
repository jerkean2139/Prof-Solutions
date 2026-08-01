import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Auth. Enforcement is off until dev and test are done on mock data.
  AUTH_ENFORCED: bool.default('false'),
  CLERK_SECRET_KEY: z.string().default(''),
  CLERK_PUBLISHABLE_KEY: z.string().default(''),

  // GoHighLevel. Outbound is queued, never fired inline.
  GHL_API_BASE: z.string().default('https://services.leadconnectorhq.com'),
  GHL_API_KEY: z.string().default(''),
  GHL_LOCATION_ID: z.string().default(''),

  ACCEPT_BLUE_WEBHOOK_SECRET: z.string().default(''),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

// A single guard so nothing enforces auth without real keys behind it.
if (env.AUTH_ENFORCED && !env.CLERK_SECRET_KEY) {
  throw new Error(
    'AUTH_ENFORCED is true but CLERK_SECRET_KEY is empty. Set the key or turn enforcement off.',
  );
}
