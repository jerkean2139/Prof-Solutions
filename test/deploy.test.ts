import { describe, expect, it } from 'vitest';
import { resolveSsl } from '../src/db/pool.js';
import { redisOptions } from '../src/redis/connection.js';

// The deploy-shaped failures these cover are invisible locally: they only show
// up against a managed Postgres/Redis, as a boot crash or a reconnect storm.

describe('postgres ssl resolution', () => {
  const internal = 'postgres://user:pw@postgres.railway.internal:5432/railway';
  const proxy = 'postgres://user:pw@shinkansen.proxy.rlwy.net:23456/railway?sslmode=require';

  it('stays plaintext on a private network url', () => {
    expect(resolveSsl(internal, 'auto')).toBeUndefined();
  });

  it('enables tls without ca verification when the url asks for it', () => {
    expect(resolveSsl(proxy, 'auto')).toEqual({ rejectUnauthorized: false });
  });

  it('verifies the chain for sslmode=verify-full', () => {
    expect(resolveSsl(`${internal}?sslmode=verify-full`, 'auto')).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('honours an explicit override in both directions', () => {
    expect(resolveSsl(internal, 'require')).toEqual({ rejectUnauthorized: false });
    expect(resolveSsl(proxy, 'disable')).toBeUndefined();
  });

  it('does not throw on a url it cannot parse', () => {
    expect(resolveSsl('not a url', 'auto')).toBeUndefined();
  });
});

describe('redis connection options', () => {
  it('lets the resolver pick a family so ipv6-only hosts resolve', () => {
    // ioredis defaults to family 4, and a private-network hostname publishes
    // AAAA records only: that combination is ENOTFOUND on every attempt.
    expect(redisOptions('redis://default:pw@redis.railway.internal:6379').family).toBe(0);
  });

  it('respects an explicit family in the url', () => {
    expect(redisOptions('redis://127.0.0.1:6379?family=4').family).toBe(4);
  });

  it('keeps the setting bullmq requires', () => {
    expect(redisOptions('redis://127.0.0.1:6379').maxRetriesPerRequest).toBeNull();
  });

  it('caps the reconnect backoff', () => {
    const retry = redisOptions('redis://127.0.0.1:6379').retryStrategy;
    expect(typeof retry).toBe('function');
    expect(retry?.(1000)).toBe(5_000);
  });
});
