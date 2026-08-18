import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

// Two things bite every Redis deploy and neither is obvious from the logs.
//
// 1. ioredis defaults to IPv4 (family 4). Railway's private network only
//    publishes AAAA records, so `redis.railway.internal` resolves to nothing
//    and every connect attempt dies with ENOTFOUND. family 0 lets the resolver
//    take whichever record exists, which is right on Railway and harmless on a
//    plain IPv4 host.
// 2. An ioredis client with no 'error' listener turns every failed reconnect
//    into an unhandled error event. Deploy logs fill with identical stack
//    traces at reconnect speed and the real failure scrolls away. We log the
//    first error per client, then stay quiet until it recovers.
//
// An explicit ?family= in REDIS_URL still wins: this only supplies the default.
function familyFromUrl(url: string): number | undefined {
  try {
    const value = new URL(url).searchParams.get('family');
    if (value === null) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function redisOptions(url: string = env.REDIS_URL): RedisOptions {
  return {
    // BullMQ requires this on its connections.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    family: familyFromUrl(url) ?? 0,
    // Cap the reconnect backoff. The default climbs by 50ms forever, which on a
    // long outage means minutes between attempts.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    connectTimeout: 10_000,
  };
}

export function createRedisConnection(name = 'redis'): Redis {
  const client = new Redis(env.REDIS_URL, redisOptions());

  // Deduplicate the reconnect storm: one line per failure, not one per retry.
  let reported = false;
  client.on('error', (err: Error) => {
    if (reported) return;
    reported = true;
    logger.error({ name, err: err.message }, 'redis connection error');
  });
  client.on('ready', () => {
    if (reported) logger.info({ name }, 'redis connection recovered');
    reported = false;
  });

  return client;
}

// A general-purpose client for caching (e.g. the inventory snapshot for the
// ops agent). Kept separate from the queue connections.
export const redis = createRedisConnection('cache');
