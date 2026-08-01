import { rebuildSnapshots } from './snapshot.js';
import { closePool } from '../db/pool.js';
import { logger } from '../logger.js';

// CLI: npm run snapshot:rebuild
async function main(): Promise<void> {
  const rows = await rebuildSnapshots();
  logger.info({ rows: rows.length }, 'snapshot rebuild complete');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error({ err: (err as Error).message }, 'snapshot rebuild failed');
    await closePool();
    process.exit(1);
  });
