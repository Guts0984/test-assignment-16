// Fixed-window rate limiter in Redis (one atomic Lua call, shared by every api copy).
// Redis unavailable -> fail-open to a per-process in-memory limiter with the same limits
// (plan.md A-22). Correctness never depends on the limiter; Postgres guards hold regardless.
import { createHash } from 'node:crypto';
import { type Redis } from 'ioredis';

const LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

export type LimitDecision = {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterMs: number;
  readonly degraded: boolean;
};

export type RateLimiter = {
  readonly consume: (bucket: string, subject: string, limit: number) => Promise<LimitDecision>;
};

export type LimiterDeps = {
  readonly redis: Redis;
  readonly windowMs: number;
  readonly now?: () => number;
  readonly redisTimeoutMs?: number;
  readonly prefix?: string;
};

/** Subjects (IPs, emails, key prefixes) are hashed so Redis never holds raw identifiers. */
const subjectKey = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('redis timeout')), ms).unref())]);

export const createRateLimiter = (d: LimiterDeps): RateLimiter => {
  const now = d.now ?? Date.now;
  const prefix = d.prefix ?? 'rl';
  const local = new Map<string, number>();
  const decide = (n: number, limit: number, windowEnd: number, t: number, degraded: boolean): LimitDecision => ({
    allowed: n <= limit,
    limit,
    remaining: Math.max(0, limit - n),
    retryAfterMs: n <= limit ? 0 : Math.max(1, windowEnd - t),
    degraded,
  });
  const localConsume = (key: string, windowIdx: number): number => {
    if (local.size > 50_000) {
      for (const k of local.keys()) if (!k.endsWith(`:${windowIdx}`)) local.delete(k);
    }
    const n = (local.get(key) ?? 0) + 1;
    local.set(key, n);
    return n;
  };
  return {
    consume: async (bucket, subject, limit) => {
      const t = now();
      const windowIdx = Math.floor(t / d.windowMs);
      const windowEnd = (windowIdx + 1) * d.windowMs;
      const key = `${prefix}:${bucket}:${subjectKey(subject)}:${windowIdx}`;
      try {
        const n = Number(await timeout(d.redis.eval(LUA, 1, key, String(d.windowMs * 2)), d.redisTimeoutMs ?? 250));
        return decide(n, limit, windowEnd, t, false);
      } catch {
        return decide(localConsume(key, windowIdx), limit, windowEnd, t, true);
      }
    },
  };
};
