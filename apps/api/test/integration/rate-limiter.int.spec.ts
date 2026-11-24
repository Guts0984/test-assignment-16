// The limiter against real Redis: atomic under parallel load, shared by two api copies,
// exact at the window boundary, keys expire, and fail-open when Redis is gone.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisOptions } from '@ff/core/redis';
import { createRateLimiter } from '../../src/common/rate-limit/limiter';
import { testEnv } from '../setup/test-env';

let redisA: Redis;
let redisB: Redis;
beforeAll(async () => {
  const fast = {
    ...redisOptions(testEnv.REDIS_URL),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  };
  redisA = new Redis(fast);
  redisB = new Redis(fast);
  await Promise.all([redisA.connect(), redisB.connect()]);
});
afterAll(() => {
  redisA.disconnect();
  redisB.disconnect();
});

const uniq = (): string => `s-${Math.random().toString(36).slice(2)}`;

describe('rate limiter on real Redis', () => {
  it('off-by-one: exactly `limit` requests pass, the next gets a correct Retry-After', async () => {
    const t = { v: 1_000_000 };
    const l = createRateLimiter({ redis: redisA, windowMs: 60_000, now: () => t.v, prefix: uniq() });
    const res = [];
    for (let i = 0; i < 6; i += 1) res.push(await l.consume('login', 'ip-1', 5));
    expect(res.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(res.every((r) => !r.degraded)).toBe(true);
    expect(res[4]?.remaining).toBe(0);
    // window [960_000, 1_020_000): 20 s left
    expect(res[5]?.retryAfterMs).toBe(20_000);
  });

  it('500 parallel requests on a limit of 50 across two api copies: exactly 50 allowed', async () => {
    const prefix = uniq();
    const a = createRateLimiter({ redis: redisA, windowMs: 60_000, prefix });
    const b = createRateLimiter({ redis: redisB, windowMs: 60_000, prefix });
    const res = await Promise.all(
      Array.from({ length: 500 }, (_, i) => (i % 2 ? a : b).consume('api', 'key-1', 50)),
    );
    expect(res.filter((r) => r.allowed)).toHaveLength(50);
    expect(res.some((r) => r.degraded)).toBe(false);
  });

  it('one subject flooding does not consume another subject budget', async () => {
    const l = createRateLimiter({ redis: redisA, windowMs: 60_000, prefix: uniq() });
    await Promise.all(Array.from({ length: 100 }, () => l.consume('login', 'attacker', 5)));
    expect(await l.consume('login', 'victim', 5)).toMatchObject({ allowed: true, degraded: false });
  });

  it('recovers in the next window and keys carry a TTL', async () => {
    const t = { v: 5 * 60_000 };
    const prefix = uniq();
    const l = createRateLimiter({ redis: redisA, windowMs: 60_000, now: () => t.v, prefix });
    await l.consume('x', 'y', 1);
    expect((await l.consume('x', 'y', 1)).allowed).toBe(false);
    t.v += 59_999;
    expect((await l.consume('x', 'y', 1)).allowed).toBe(false);
    t.v += 1;
    expect((await l.consume('x', 'y', 1)).allowed).toBe(true);
    const keys = await redisA.keys(`${prefix}:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const ttl = await redisA.pttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120_000);
    }
  });

  it('never stores raw subjects in Redis keys', async () => {
    const prefix = uniq();
    const l = createRateLimiter({ redis: redisA, windowMs: 60_000, prefix });
    await l.consume('login', 'alice@example.com', 5);
    const keys = await redisA.keys(`${prefix}:*`);
    expect(keys.join()).not.toContain('alice');
  });

  it('Redis down: fails open to a local limiter with the same limit (degraded)', async () => {
    const dead = new Redis({
      host: '127.0.0.1',
      port: 1,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    try {
      const l = createRateLimiter({ redis: dead, windowMs: 60_000, prefix: uniq(), redisTimeoutMs: 100 });
      const res = [];
      for (let i = 0; i < 4; i += 1) res.push(await l.consume('login', 'ip', 3));
      expect(res.map((r) => [r.allowed, r.degraded])).toEqual([
        [true, true],
        [true, true],
        [true, true],
        [false, true],
      ]);
    } finally {
      dead.disconnect();
    }
  });
});
