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

// The default planner is intentionally not wired to a model. Wiring it to the
// Anthropic Messages API (build the prompt from schemaText, require a single
// SELECT back) is the one remaining step, and it needs ANTHROPIC_API_KEY plus a
// live verification pass before it can be trusted. Until then this reports the
// truth rather than fabricating SQL.
export const notConfiguredPlanner: SqlPlanner = async () => {
  const detail = env.ANTHROPIC_API_KEY
    ? 'ANTHROPIC_API_KEY is set but the model planner has not been wired and verified yet.'
    : 'Set ANTHROPIC_API_KEY and wire the model planner to enable natural-language queries.';
  throw new AgentNotConfiguredError(`Ops agent natural-language planner is not configured. ${detail}`);
};
