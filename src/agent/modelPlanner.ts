import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import {
  AgentNotConfiguredError,
  notConfiguredPlanner,
  type SqlPlan,
  type SqlPlanner,
} from './planner.js';

// The model planner: turns a natural-language question plus the schema into one
// read-only SELECT. It produces SQL and nothing else — it never executes
// anything. Every statement it returns still goes through the SQL guard, the
// profsol_readonly role, and a READ ONLY transaction (rule 10), so this is the
// convenience layer, never the safety layer.

const MODEL = 'claude-opus-5';

// Non-streaming, so this stays under the SDK's HTTP timeout while leaving room
// for thinking (which counts against max_tokens and is on by default).
const MAX_TOKENS = 16_000;

// SQL-from-schema is a bounded, well-specified task and this is an interactive
// question box, so medium buys most of the quality at a fraction of the latency.
const EFFORT = 'medium';

// Structured output: the model must return exactly this shape, so there is no
// prose to strip and no fenced code block to unwrap.
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    sql: {
      type: 'string',
      description: 'A single read-only SQL SELECT (or WITH) statement. No trailing semicolon.',
    },
    rationale: {
      type: 'string',
      description: 'One or two plain sentences explaining what the query counts or measures.',
    },
  },
  required: ['sql', 'rationale'],
  additionalProperties: false,
} as const;

// What the planner must know to write *correct* queries, not merely safe ones.
// The guard catches unsafe SQL; nothing catches a query that quietly counts
// soft-deleted rows, so the business rules that shape a correct answer belong
// here.
function systemPrompt(schemaText: string): string {
  return [
    'You write read-only SQL for the Profitable Solutions operations database (PostgreSQL).',
    'You are given a question and the schema. Return one SQL statement that answers it.',
    '',
    'Hard requirements — a statement that breaks any of these is rejected before it runs:',
    '- Exactly one statement. No semicolons at all, not even a trailing one.',
    '- It must begin with SELECT or WITH.',
    '- Read-only. Never INSERT, UPDATE, DELETE, or any DDL, and no functions with side effects.',
    '',
    'Rules for getting the answer right:',
    '- Every table uses soft deletes. Add `deleted_at IS NULL` for each table you read',
    '  unless the question is explicitly about deleted records.',
    '- Money columns are NUMERIC(12,2). Do not cast them to float or round them away.',
    '- On-hand inventory is derived from the append-only `inventory_transactions` ledger.',
    '  `inventory_snapshots` is a cache of that ledger; prefer it for a plain current',
    '  on-hand reading, but sum the ledger when the question is about history or movement.',
    '- Sales are the `campaigns` table. A sale is finalized when its status says so;',
    '  do not treat draft or open sales as revenue.',
    '- Use explicit JOIN ... ON, and qualify columns when more than one table is in play.',
    '- Order the result the way a person would expect to read it, and keep it to the',
    '  columns the question actually asks for.',
    '',
    'If the question cannot be answered from this schema, return a SELECT that yields',
    'zero rows and say so plainly in the rationale. Never invent a table or a column.',
    '',
    'Schema (one line per table):',
    schemaText,
  ].join('\n');
}

export interface ModelPlannerOptions {
  apiKey?: string;
  model?: string;
  client?: Anthropic;
}

// Builds a planner backed by the Messages API. Throws AgentNotConfiguredError
// rather than returning a planner that will fail later on every call.
export function createModelPlanner(opts: ModelPlannerOptions = {}): SqlPlanner {
  const apiKey = opts.apiKey ?? env.ANTHROPIC_API_KEY;
  if (!opts.client && !apiKey) {
    throw new AgentNotConfiguredError(
      'Ops agent natural-language planner is not configured. Set ANTHROPIC_API_KEY to enable natural-language queries.',
    );
  }
  const client = opts.client ?? new Anthropic({ apiKey });
  const model = opts.model ?? MODEL;

  return async function modelPlanner(question: string, schemaText: string): Promise<SqlPlan> {
    const started = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(schemaText),
      output_config: {
        effort: EFFORT,
        format: { type: 'json_schema', schema: PLAN_SCHEMA },
      },
      messages: [{ role: 'user', content: question }],
    });

    // A refusal is a successful HTTP response with no usable content, so this
    // has to be checked before reading any content block.
    if (response.stop_reason === 'refusal') {
      logger.warn({ question }, 'ops agent planner refused the question');
      throw new AgentNotConfiguredError(
        'The assistant declined to answer that question. Rephrase it as a question about the operational data.',
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('planner response was truncated before it produced a complete query');
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (!text.trim()) throw new Error('planner returned no content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('planner did not return valid JSON');
    }
    const plan = parsed as Partial<SqlPlan>;
    if (typeof plan.sql !== 'string' || !plan.sql.trim()) {
      throw new Error('planner returned no SQL');
    }

    logger.info(
      { model, ms: Date.now() - started, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      'ops agent planned a query',
    );

    return { sql: plan.sql.trim(), rationale: plan.rationale };
  };
}

// Picks the planner the running configuration supports: the model planner when
// a key is present, otherwise the one that says so plainly. The client is built
// once and cached, so a key present at boot takes effect with no other wiring,
// and the test suite — which runs without a key — keeps the not-configured
// behaviour it asserts on.
let cached: SqlPlanner | undefined;

export function resolvePlanner(): SqlPlanner {
  if (!env.ANTHROPIC_API_KEY) return notConfiguredPlanner;
  cached ??= createModelPlanner();
  return cached;
}
