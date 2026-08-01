import { startGhlWorker } from './queue/ghlQueue.js';
import { ghlClient } from './integrations/ghl/client.js';
import { logger } from './logger.js';

// The GHL outbound worker. Run this as its own process (npm run worker) so a
// slow or failing GHL API never touches the request path. It drains the queue,
// calls the real client, and BullMQ handles retry/backoff; the dead-letter
// handling lives in startGhlWorker.
const worker = startGhlWorker((job) => ghlClient.handleJob(job.name, job.data));

logger.info('ghl outbound worker started');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down ghl worker');
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
