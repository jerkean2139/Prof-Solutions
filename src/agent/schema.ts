import { pool } from '../db/pool.js';

// Schema introspection. This is the grounding context a natural-language planner
// needs to write correct SQL, and it is safe to expose on its own: it reveals
// table and column names, never data. Read-only by construction.

export interface TableSchema {
  table: string;
  columns: { name: string; type: string }[];
}

export async function describeSchema(): Promise<{ tables: TableSchema[] }> {
  const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.table_name <> 'schema_migrations'
      ORDER BY c.table_name, c.ordinal_position`,
  );

  const byTable = new Map<string, TableSchema>();
  for (const r of rows) {
    let entry = byTable.get(r.table_name);
    if (!entry) {
      entry = { table: r.table_name, columns: [] };
      byTable.set(r.table_name, entry);
    }
    entry.columns.push({ name: r.column_name, type: r.data_type });
  }
  return { tables: [...byTable.values()] };
}

// A compact one-line-per-table rendering for use as planner context.
export async function schemaAsText(): Promise<string> {
  const { tables } = await describeSchema();
  return tables
    .map((t) => `${t.table}(${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')})`)
    .join('\n');
}
