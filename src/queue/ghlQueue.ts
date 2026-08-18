import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { createRedisConnection } from '../redis/connection.js';
import { logger } from '../logger.js';
import { env } from '../config/env.js';

// The integration contract is explicit: every outbound GoHighLevel call goes
// on a Redis queue with retry and exponential backoff, and a GHL API failure
// must never block an inventory operation or an order. This module is that
// queue. Nothing calls GHL synchronously.
//
// Failure policy from the contract: three consecutive failures on the same job
// moves it to a dead letter queue and alerts an admin.

export const GHL_QUEUE_NAME = 'ghl-outbound';
export const GHL_DEAD_LETTER_QUEUE_NAME = 'ghl-outbound-dead-letter';

const MAX_ATTEMPTS = 3;

export type GhlJobName =
  | 'store.provision'
  | 'rep.approved'
  | 'seller.approved'
  | 'territory.assigned'
  | 'sale.finalized'
  | 'growth.next_sale'
  | 'shipment.sent'
  | 'commission.updated';

export interface GhlJobData {
  // The GHL contact or location the update targets.
  targetId: string;
  // Tags to apply and custom fields to write. The message itself is a GHL
  // workflow, never sent from here.
  tags?: string[];
  customFields?: Record<string, string | number>;
  // Free-form context for logging and the eventual API call.
  payload?: Record<string, unknown>;
}

export const defaultJobOptions: JobsOptions = {
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  // Keep failed jobs so a human can inspect them alongside the dead letter row.
  removeOnFail: false,
};

let queue: Queue<GhlJobData, unknown, GhlJobName> | undefined;
let deadLetterQueue: Queue<GhlJobData, unknown, GhlJobName> | undefined;

export function getGhlQueue(): Queue<GhlJobData, unknown, GhlJobName> {
  if (!queue) {
    queue = new Queue(GHL_QUEUE_NAME, {
      connection: createRedisConnection('ghl-queue'),
      defaultJobOptions,
    });
  }
  return queue;
}

export function getDeadLetterQueue(): Queue<GhlJobData, unknown, GhlJobName> {
  if (!deadLetterQueue) {
    deadLetterQueue = new Queue(GHL_DEAD_LETTER_QUEUE_NAME, {
      connection: createRedisConnection('ghl-dead-letter'),
    });
  }
  return deadLetterQueue;
}

// Enqueue an outbound GHL job. This is the only entry point the rest of the
// application uses to reach GoHighLevel.
export async function enqueueGhlJob(
  name: GhlJobName,
  data: GhlJobData,
  opts?: JobsOptions,
): Promise<string> {
  const job = await getGhlQueue().add(name, data, opts);
  logger.info({ jobId: job.id, name, targetId: data.targetId }, 'ghl job enqueued');
  return job.id as string;
}

// Start the worker that drains the queue. The processor is injected so tests
// and Phase 1 can supply the real GHL client without this module importing it.
export function startGhlWorker(
  processor: (job: Job<GhlJobData, unknown, GhlJobName>) => Promise<void>,
): Worker<GhlJobData, unknown, GhlJobName> {
  const worker = new Worker<GhlJobData, unknown, GhlJobName>(
    GHL_QUEUE_NAME,
    async (job) => {
      logger.info(
        { jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 },
        'ghl job processing',
      );
      await processor(job);
    },
    {
      connection: createRedisConnection('ghl-worker'),
      // Batch under GHL's rate limits: at most MAX jobs per DURATION window.
      // A bulk sale finalize cannot fire hundreds of calls in a burst.
      limiter: { max: env.GHL_RATE_LIMIT_MAX, duration: env.GHL_RATE_LIMIT_DURATION_MS },
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    logger.warn(
      { jobId: job.id, name: job.name, attempt: job.attemptsMade, err: err.message },
      'ghl job attempt failed',
    );
    // Contract: after the final attempt, move to the dead letter queue and
    // alert an admin.
    if (job.attemptsMade >= MAX_ATTEMPTS) {
      await getDeadLetterQueue().add(job.name as GhlJobName, job.data, {
        removeOnComplete: false,
      });
      logger.error(
        { jobId: job.id, name: job.name, err: err.message },
        'ghl job dead-lettered after max attempts; admin alert required',
      );
    }
  });

  return worker;
}
