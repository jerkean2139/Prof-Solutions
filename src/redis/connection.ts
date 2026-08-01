import { Redis } from 'ioredis';
import { env } from '../config/env.js';

// BullMQ requires maxRetriesPerRequest: null on its connections. A single
// shared factory keeps that consistent everywhere.
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

// A general-purpose client for caching (e.g. the inventory snapshot for the
// ops agent). Kept separate from the queue connections.
export const redis = createRedisConnection();
