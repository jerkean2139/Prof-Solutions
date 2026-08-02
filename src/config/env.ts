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
  // Custom field IDs are specific to a GHL location and cannot be guessed. Map
  // our logical field names to the account's real field IDs, e.g.
  // {"sale_total_raised":"abc123","tracking_number":"def456"}. Unmapped fields
  // are skipped (logged), never invented.
  GHL_CUSTOM_FIELD_IDS: z
    .string()
    .default('{}')
    .transform((s, ctx) => {
      try {
        const obj = JSON.parse(s) as Record<string, string>;
        return obj;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
        return z.NEVER;
      }
    }),
  // GHL enforces rate limits and they change. Read current limits from their
  // docs before tuning. Conservative defaults; the worker batches under these.
  GHL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  GHL_RATE_LIMIT_DURATION_MS: z.coerce.number().int().positive().default(1000),

  ACCEPT_BLUE_WEBHOOK_SECRET: z.string().default(''),

  // Phase 3 read-only ops agent. The agent turns a natural-language question
  // into a single SELECT and runs it under the profsol_readonly role in a READ
  // ONLY transaction. Without an API key the natural-language planner is not
  // configured and the query endpoint reports that plainly; the SQL-safety and
  // schema-introspection layers work and are tested without a key.
  ANTHROPIC_API_KEY: z.string().default(''),
  // Belt-and-suspenders caps on any agent query.
  AGENT_QUERY_MAX_ROWS: z.coerce.number().int().positive().default(200),
  AGENT_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // When true, agent queries SET LOCAL ROLE to profsol_readonly. Requires the
  // connecting user to be a member of that role (the migration grants it). The
  // READ ONLY transaction protects even when this is off.
  AGENT_USE_READONLY_ROLE: bool.default('true'),
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
