import { describe, it, expect, afterAll } from 'vitest';
import type { Worker } from 'bullmq';
import {
  enqueueGhlJob,
  startGhlWorker,
  getGhlQueue,
  getDeadLetterQueue,
  type GhlJobData,
  type GhlJobName,
} from '../src/queue/ghlQueue.js';

let worker: Worker<GhlJobData, unknown, GhlJobName> | undefined;

afterAll(async () => {
  // Close only the Redis-backed handles this file owns. The pg pool is shared
  // across the suite and is torn down when the worker process exits.
  if (worker) await worker.close();
  await getGhlQueue().obliterate({ force: true }).catch(() => {});
  await getDeadLetterQueue().obliterate({ force: true }).catch(() => {});
  await getGhlQueue().close();
  await getDeadLetterQueue().close();
});

describe('GHL outbound queue', () => {
  it('processes a job through the worker', async () => {
    await getGhlQueue().obliterate({ force: true }).catch(() => {});
    const processed = new Promise<string>((resolve) => {
      worker = startGhlWorker(async (job) => {
        resolve(job.data.targetId);
      });
    });
    await enqueueGhlJob('sale.finalized', { targetId: 'ghl-contact-ok', tags: ['sale-complete'] });
    await expect(processed).resolves.toBe('ghl-contact-ok');
  });

  it('dead-letters a job after exhausting retries', async () => {
    const dlq = getDeadLetterQueue();
    await dlq.obliterate({ force: true }).catch(() => {});

    // Tear down the success worker fully before starting the failing one, so a
    // single worker owns the queue. Two workers would race for the job and the
    // success worker could complete it before it ever exhausts retries.
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    await getGhlQueue().obliterate({ force: true }).catch(() => {});

    // A processor that always throws, with fast retries so the test is quick.
    worker = startGhlWorker(async () => {
      throw new Error('simulated GHL failure');
    });

    await enqueueGhlJob(
      'growth.next_sale',
      { targetId: 'ghl-contact-fail', tags: ['next-sale-eligible'] },
      { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
    );

    // Poll the dead letter queue until the job lands (or time out).
    const deadline = Date.now() + 8_000;
    let waiting = 0;
    while (Date.now() < deadline) {
      waiting = await dlq.getWaitingCount();
      if (waiting >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(waiting).toBeGreaterThanOrEqual(1);
  });
});
