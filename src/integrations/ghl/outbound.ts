import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { enqueueGhlJob, type GhlJobData, type GhlJobName } from '../../queue/ghlQueue.js';

// The single seam operations use to reach GoHighLevel. It enqueues an outbound
// job and never throws into the caller: a GHL failure must never block an
// order, a finalize, or an inventory operation (integration contract).
//
// In tests it is a no-op so the suite stays hermetic and does not open Redis
// queue connections. The queue itself is covered by queue.test.ts.
export async function emitGhlEvent(name: GhlJobName, data: GhlJobData): Promise<void> {
  if (env.NODE_ENV === 'test') {
    logger.debug({ name, targetId: data.targetId }, 'ghl event suppressed in test');
    return;
  }
  try {
    await enqueueGhlJob(name, data);
  } catch (err) {
    logger.error({ name, err: (err as Error).message }, 'failed to enqueue ghl event');
  }
}
