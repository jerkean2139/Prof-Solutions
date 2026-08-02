import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated } from './helpers.js';
import {
  assertSingleReadOnlyStatement,
  wrapWithLimit,
  stripComments,
  UnsafeQueryError,
} from '../src/agent/sqlGuard.js';
import { runReadOnlyQuery, runInReadOnlyTx } from '../src/agent/executor.js';
import { describeSchema, schemaAsText } from '../src/agent/schema.js';
import { answerQuestion } from '../src/agent/ask.js';
import { AgentNotConfiguredError, type SqlPlanner } from '../src/agent/planner.js';

describe('read-only ops agent', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  describe('SQL guard', () => {
    it('accepts a single SELECT and a WITH query', () => {
      expect(() => assertSingleReadOnlyStatement('SELECT 1')).not.toThrow();
      expect(() =>
        assertSingleReadOnlyStatement('WITH x AS (SELECT 1 AS n) SELECT n FROM x'),
      ).not.toThrow();
    });

    it('does not flag created_at / updated_at / deleted_at columns', () => {
      expect(() =>
        assertSingleReadOnlyStatement(
          'SELECT id, created_at, updated_at FROM orders WHERE deleted_at IS NULL',
        ),
      ).not.toThrow();
    });

    it('rejects writes and DDL', () => {
      for (const sql of [
        "INSERT INTO products (name) VALUES ('x')",
        'UPDATE orders SET status = 1',
        'DELETE FROM orders',
        'DROP TABLE orders',
        'ALTER TABLE orders ADD COLUMN x int',
        'TRUNCATE orders',
        'GRANT SELECT ON orders TO public',
      ]) {
        expect(() => assertSingleReadOnlyStatement(sql), sql).toThrow(UnsafeQueryError);
      }
    });

    it('rejects multiple statements and non-select starts', () => {
      expect(() => assertSingleReadOnlyStatement('SELECT 1; DELETE FROM orders')).toThrow(
        /single statement/,
      );
      expect(() => assertSingleReadOnlyStatement('EXPLAIN SELECT 1')).toThrow(/SELECT or WITH/);
    });

    it('strips comments before validating, neutralizing hidden keywords', () => {
      // The DROP lives entirely inside a comment, so it is removed and what
      // remains is a safe single SELECT.
      expect(stripComments('SELECT 1 /* ; DROP TABLE orders */')).toBe('SELECT 1');
      expect(() => assertSingleReadOnlyStatement('SELECT 1 /* ; DROP TABLE orders */')).not.toThrow();
      // A keyword split by a comment does not reassemble into a valid statement.
      expect(() => assertSingleReadOnlyStatement('/* */ UP/**/DATE orders SET x=1')).toThrow();
      expect(stripComments('SELECT 1 -- comment\n , 2')).toBe('SELECT 1 , 2');
    });

    it('wraps a query in an outer LIMIT', () => {
      expect(wrapWithLimit('SELECT 1', 10)).toBe('SELECT * FROM (SELECT 1) AS agent_query LIMIT 11');
    });
  });

  describe('read-only executor', () => {
    it('runs a SELECT and returns columns and rows', async () => {
      const res = await runReadOnlyQuery('SELECT count(*)::int AS n FROM products');
      expect(res.columns).toContain('n');
      expect(res.rows).toHaveLength(1);
      expect(typeof res.rows[0]!.n).toBe('number');
    });

    it('caps rows at maxRows and flags truncation', async () => {
      const res = await runReadOnlyQuery(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public'`,
        { maxRows: 3 },
      );
      expect(res.rows).toHaveLength(3);
      expect(res.truncated).toBe(true);
    });

    it('rejects a write at the database level even without the guard (defense in depth)', async () => {
      // runInReadOnlyTx is the low-level runner the guard normally protects. A
      // write submitted directly must still be refused by the READ ONLY
      // transaction and the read-only role.
      await expect(
        runInReadOnlyTx("INSERT INTO products (name, brand, category, owner_entity) VALUES ('x','y','candle','z')"),
      ).rejects.toThrow(/read-only|permission denied/i);
    });
  });

  describe('schema introspection', () => {
    it('describes public tables with columns', async () => {
      const { tables } = await describeSchema();
      const names = tables.map((t) => t.table);
      expect(names).toContain('products');
      expect(names).toContain('orders');
      expect(names).toContain('inventory_transactions');
      expect(names).not.toContain('schema_migrations');
      const products = tables.find((t) => t.table === 'products')!;
      expect(products.columns.some((c) => c.name === 'name')).toBe(true);
    });

    it('renders compact planner text', async () => {
      const text = await schemaAsText();
      expect(text).toMatch(/products\(/);
    });
  });

  describe('answerQuestion', () => {
    it('runs an injected planner end to end', async () => {
      const planner: SqlPlanner = async () => ({
        sql: 'SELECT count(*)::int AS teams FROM organizations',
        rationale: 'count of teams',
      });
      const answer = await answerQuestion('how many teams?', { planner });
      expect(answer.sql).toContain('organizations');
      expect(answer.rationale).toBe('count of teams');
      expect(typeof answer.result.rows[0]!.teams).toBe('number');
    });

    it('refuses a planner that returns a write', async () => {
      const planner: SqlPlanner = async () => ({ sql: 'DELETE FROM orders' });
      await expect(answerQuestion('delete everything', { planner })).rejects.toThrow(
        UnsafeQueryError,
      );
    });

    it('reports not-configured when no planner is supplied', async () => {
      await expect(answerQuestion('anything')).rejects.toThrow(AgentNotConfiguredError);
    });
  });
});
