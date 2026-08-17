import { schemaAsText } from './schema.js';
import { runReadOnlyQuery, type QueryResult } from './executor.js';
import { type SqlPlanner } from './planner.js';
import { resolvePlanner } from './modelPlanner.js';

// Ties the read-only ops agent together: describe the schema, ask the planner
// for one SELECT, then run it through the guard and the read-only executor.
// The planner is injected (tests pass a canned one); it defaults to the
// not-configured planner so nothing fabricates SQL without a real model.

export interface AgentAnswer {
  question: string;
  sql: string;
  rationale?: string;
  result: QueryResult;
}

export async function answerQuestion(
  question: string,
  opts?: { planner?: SqlPlanner; maxRows?: number; timeoutMs?: number },
): Promise<AgentAnswer> {
  const planner = opts?.planner ?? resolvePlanner();
  const schemaText = await schemaAsText();
  const plan = await planner(question, schemaText);
  const result = await runReadOnlyQuery(plan.sql, {
    maxRows: opts?.maxRows,
    timeoutMs: opts?.timeoutMs,
  });
  return { question, sql: plan.sql, rationale: plan.rationale, result };
}
