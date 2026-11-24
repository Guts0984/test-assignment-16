// Builds the worker's dependency bundle from configuration: the one place that wires infrastructure.
import { randomUUID } from 'node:crypto';
import { type Redis } from 'ioredis';
import { createDb, type Db } from '@ff/db/client';
import { startSharedTestClock, systemClock, type Clock, type SharedTestClock } from '@ff/core/clock';
import { allHandlers, type AllHandlerDeps } from '@ff/core/jobs/handlers';
import { type JobDeps } from '@ff/core/jobs/run-action';
import { createQueues, type Queues } from '@ff/core/queues';
import { createRedis, createRedisEmitter, redisOptions } from '@ff/core/redis';
import { type WorkerEnv } from '../config/env';

export type Runtime = {
  readonly env: WorkerEnv;
  readonly workerId: string;
  readonly db: Db;
  readonly redis: Redis;
  readonly queues: Queues;
  readonly clock: Clock;
  readonly jobDeps: JobDeps;
  readonly stop: () => Promise<void>;
};

export const buildRuntime = async (env: WorkerEnv): Promise<Runtime> => {
  const db = createDb({ url: env.DATABASE_URL, poolSize: env.DB_POOL_SIZE });
  const redis = createRedis(env.REDIS_URL, 'worker');
  redis.on('error', () => undefined);
  const queues = createQueues(redisOptions(env.REDIS_URL));
  const testClock: SharedTestClock | null = env.TEST_CLOCK_ENABLED
    ? await startSharedTestClock(env.DATABASE_URL)
    : null;
  const clock = testClock?.clock ?? systemClock;
  const base = {
    db,
    clock,
    emitter: createRedisEmitter(redis),
    queues,
    settings: {
      webhookCoalesceMs: env.WEBHOOK_COALESCE_MS,
      partialReserveTtlMin: env.PARTIAL_RESERVE_TTL_MIN,
      waveReadyThreshold: env.WAVE_READY_THRESHOLD,
      waveMaxOrders: env.WAVE_MAX_ORDERS,
      waveIntervalMin: env.WAVE_INTERVAL_MIN,
    },
    jobs: {
      leaseMs: env.JOB_LEASE_MS,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
      backoffBaseMs: env.JOB_BACKOFF_MS,
      backoffMaxMs: env.WEBHOOK_BACKOFF_MAX_MS,
      byKind: {
        webhook_stream: {
          maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
          backoffBaseMs: env.WEBHOOK_BACKOFF_BASE_MS,
          backoffMaxMs: env.WEBHOOK_BACKOFF_MAX_MS,
        },
      },
    },
  } as const;
  const handlerDeps: AllHandlerDeps = {
    ...base,
    nightlyLocalTime: env.NIGHTLY_LOCAL_TIME,
    webhooks: {
      encKey: env.WEBHOOK_SECRET_ENC_KEY,
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
      coalesceMs: env.WEBHOOK_COALESCE_MS,
      allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_HOSTS,
    },
  };
  return {
    env,
    workerId: env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
    db,
    redis,
    queues,
    clock,
    jobDeps: { ...base, handlers: allHandlers(handlerDeps) },
    stop: async () => {
      await Promise.allSettled([queues.close(), db.$disconnect(), testClock?.stop()]);
      redis.disconnect();
    },
  };
};
