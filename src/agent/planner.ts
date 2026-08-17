import { env } from '../config/env.js';

// The planner turns a natural-language question plus the schema into a single
// read-only SQL statement. It is an injectable seam, exactly like the Clerk
// token verifier: the whole pipeline around it (schema context, SQL guard,
// read-only execution) is built and tested without it, and the model client
// drops in behind this interface when the key is supplied and verified.

export interface SqlPlan {
  sql: string;
  rationale?: string;
}

export type SqlPlanner = (question: string, schemaText: string) => Promise<SqlPlan>;

export class AgentNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = 'agent_not_configured';
  constructor(message: string) {
    super(message);
    this.name = 'AgentNotConfiguredError';
  }
}

// Used when there is no key. It reports the truth rather than fabricating SQL.
export const notConfiguredPlanner: SqlPlanner = async () => {
  throw new AgentNotConfiguredError(
    'Ops agent natural-language planner is not configured. Set ANTHROPIC_API_KEY to enable natural-language queries.',
  );
};

// `resolvePlanner` (which picks between this and the model planner) lives in
// modelPlanner.ts, so this module stays a dependency-free seam.
