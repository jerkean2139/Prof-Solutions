// SQL safety for the read-only ops agent (Phase 3). This guard is the first of
// three layers, and deliberately not the only one:
//   1. this guard: the statement must be a single read-only SELECT/WITH
//   2. the profsol_readonly role: SELECT privilege and nothing else
//   3. a READ ONLY transaction: the database itself rejects any write
// A denylist alone is weak, so it never stands alone. Layers 2 and 3 are the
// hard guarantees; this layer fails fast with a clear message and blocks the
// obvious cases before a query ever reaches the database.

export class UnsafeQueryError extends Error {
  readonly status = 400;
  readonly code = 'unsafe_query';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeQueryError';
  }
}

// Strip -- line comments and /* */ block comments so keywords cannot hide in
// them, and collapse whitespace.
export function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Statement-level keywords and dangerous functions that must never appear in an
// agent query. Matched as whole words, case-insensitive. Column names like
// created_at / updated_at / deleted_at do not match because the word boundary
// falls inside them (create|d, update|d, delete|d).
const FORBIDDEN = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate',
  'grant', 'revoke', 'merge', 'call', 'do', 'copy', 'comment',
  'vacuum', 'analyze', 'reindex', 'refresh', 'cluster', 'lock',
  'begin', 'commit', 'rollback', 'savepoint', 'prepare', 'execute',
  'set', 'reset', 'listen', 'notify', 'discard', 'checkpoint',
  // functions with side effects or that read the filesystem / control the server
  'pg_sleep', 'nextval', 'setval', 'pg_read_file', 'pg_read_binary_file',
  'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export', 'dblink',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
];

const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'i');

// Throws UnsafeQueryError unless `sql` is exactly one read-only SELECT/WITH.
export function assertSingleReadOnlyStatement(sql: string): void {
  const cleaned = stripComments(sql).replace(/;\s*$/, '');
  if (!cleaned) throw new UnsafeQueryError('empty query');
  if (cleaned.includes(';')) {
    throw new UnsafeQueryError('only a single statement is allowed');
  }
  if (!/^(select|with)\b/i.test(cleaned)) {
    throw new UnsafeQueryError('query must start with SELECT or WITH');
  }
  const hit = FORBIDDEN_RE.exec(cleaned);
  if (hit) {
    throw new UnsafeQueryError(`query contains a forbidden keyword: ${hit[1]!.toLowerCase()}`);
  }
}

// Wrap the (validated) query in an outer LIMIT so the row cap always holds,
// regardless of any LIMIT inside the query. A parenthesized subquery may start
// with WITH, so this is valid for both forms. We fetch one extra row so the
// caller can tell a full page from a truncated one.
export function wrapWithLimit(sql: string, maxRows: number): string {
  const cleaned = stripComments(sql).replace(/;\s*$/, '');
  return `SELECT * FROM (${cleaned}) AS agent_query LIMIT ${maxRows + 1}`;
}
