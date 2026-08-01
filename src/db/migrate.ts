import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';
import { logger } from '../logger.js';

// A deliberately small, transparent migration runner. No ORM, no framework.
// The database has to outlive the application, so migrations are plain SQL a
// future team in any language can read and run. Each file carries an up and a
// down section, and every migration applies inside one transaction.
//
// File format (migrations/NNNN_name.sql):
//   -- migrate:up
//   <sql>
//   -- migrate:down
//   <sql>

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

interface Migration {
  version: string;
  name: string;
  up: string;
  down: string;
}

function splitSections(sql: string, file: string): { up: string; down: string } {
  const upMarker = /^--\s*migrate:up\s*$/im;
  const downMarker = /^--\s*migrate:down\s*$/im;
  const upIdx = sql.search(upMarker);
  const downIdx = sql.search(downMarker);
  if (upIdx === -1 || downIdx === -1 || downIdx < upIdx) {
    throw new Error(
      `Migration ${file} must contain "-- migrate:up" then "-- migrate:down".`,
    );
  }
  const up = sql.slice(sql.indexOf('\n', upIdx) + 1, downIdx).trim();
  const down = sql.slice(sql.indexOf('\n', downIdx) + 1).trim();
  if (!up) throw new Error(`Migration ${file} has an empty up section.`);
  if (!down) throw new Error(`Migration ${file} has an empty down section.`);
  return { up, down };
}

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const version = file.split('_')[0];
    if (!version || !/^\d+$/.test(version)) {
      throw new Error(`Migration ${file} must start with a numeric version.`);
    }
    const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const { up, down } = splitSections(raw, file);
    migrations.push({ version, name: file, up, down });
  }
  return migrations;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function appliedVersions(): Promise<Set<string>> {
  const { rows } = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return new Set(rows.map((r) => r.version));
}

async function applyOne(m: Migration): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.up);
    await client.query(
      'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
      [m.version, m.name],
    );
    await client.query('COMMIT');
    logger.info({ migration: m.name }, 'applied migration');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

async function revertOne(m: Migration): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.down);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [
      m.version,
    ]);
    await client.query('COMMIT');
    logger.info({ migration: m.name }, 'reverted migration');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Rollback of ${m.name} failed: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

export async function up(): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  const applied = await appliedVersions();
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    logger.info('no pending migrations');
    return;
  }
  for (const m of pending) await applyOne(m);
  logger.info({ count: pending.length }, 'migrations up to date');
}

export async function down(steps = 1): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  const applied = await appliedVersions();
  const appliedList = migrations
    .filter((m) => applied.has(m.version))
    .reverse();
  const toRevert = appliedList.slice(0, steps);
  if (toRevert.length === 0) {
    logger.info('nothing to revert');
    return;
  }
  for (const m of toRevert) await revertOne(m);
}

export async function reset(): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  const applied = await appliedVersions();
  await down(migrations.filter((m) => applied.has(m.version)).length);
}

export async function status(): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  const applied = await appliedVersions();
  for (const m of migrations) {
    const mark = applied.has(m.version) ? '[x]' : '[ ]';
    process.stdout.write(`${mark} ${m.name}\n`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  switch (cmd) {
    case 'up':
      await up();
      break;
    case 'down':
      await down(Number(process.argv[3] ?? 1));
      break;
    case 'reset':
      await reset();
      break;
    case 'status':
      await status();
      break;
    default:
      throw new Error(`Unknown command "${cmd}". Use up | down | reset | status.`);
  }
}

// Only run as a CLI, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      logger.error({ err: err.message }, 'migration command failed');
      await closePool();
      process.exit(1);
    });
}
