// Infrastructure providers: created once per process, closed on shutdown.
import { type DynamicModule, Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { createDb, type Db } from '@ff/db/client';
import { startSharedTestClock, systemClock, type Clock, type SharedTestClock } from '@ff/core/clock';
import { createQueues, type Queues } from '@ff/core/queues';
import { createRedisEmitter, redisOptions } from '@ff/core/redis';
import { type ApiEnv } from '../config/env';
import { parseTrustedProxies } from '../common/client-ip';
import { createRateLimiter } from '../common/rate-limit/limiter';
import { CLOCK, DB, EMITTER, ENV, LIMITER, QUEUES, REDIS, TEST_CLOCK, TRUSTED_PROXIES } from './tokens';

const PROVIDERS = [
  {
    provide: DB,
    inject: [ENV],
    useFactory: (e: ApiEnv): Db => createDb({ url: e.DATABASE_URL, poolSize: e.DB_POOL_SIZE }),
  },
  {
    provide: REDIS,
    inject: [ENV],
    useFactory: (e: ApiEnv): Redis =>
      new Redis({ ...redisOptions(e.REDIS_URL), connectionName: `api-${e.API_INSTANCE_ID}` }),
  },
  {
    provide: LIMITER,
    inject: [ENV],
    useFactory: (e: ApiEnv) => {
      // Fail fast while Redis is down so the limiter falls back instead of queueing commands.
      const redis = new Redis({
        ...redisOptions(e.REDIS_URL),
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      redis.on('error', () => undefined);
      return { redis, limiter: createRateLimiter({ redis, windowMs: e.RATE_LIMIT_WINDOW_MS }) };
    },
  },
  {
    provide: TEST_CLOCK,
    inject: [ENV],
    useFactory: async (e: ApiEnv): Promise<SharedTestClock | null> =>
      e.TEST_CLOCK_ENABLED ? startSharedTestClock(e.DATABASE_URL) : null,
  },
  {
    provide: CLOCK,
    inject: [TEST_CLOCK],
    useFactory: (t: SharedTestClock | null): Clock => t?.clock ?? systemClock,
  },
  {
    provide: QUEUES,
    inject: [ENV],
    useFactory: (e: ApiEnv): Queues => createQueues(redisOptions(e.REDIS_URL)),
  },
  { provide: EMITTER, inject: [REDIS], useFactory: (r: Redis) => createRedisEmitter(r) },
  {
    provide: TRUSTED_PROXIES,
    inject: [ENV],
    useFactory: (e: ApiEnv) => parseTrustedProxies(e.TRUSTED_PROXY_CIDRS),
  },
];

@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: InfraModule,
      providers: [{ provide: ENV, useValue: env }, ...PROVIDERS],
      exports: [ENV, DB, REDIS, LIMITER, TEST_CLOCK, CLOCK, QUEUES, EMITTER, TRUSTED_PROXIES],
    };
  }

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LIMITER) private readonly limiter: { redis: Redis },
    @Inject(QUEUES) private readonly queues: Queues,
    @Inject(TEST_CLOCK) private readonly testClock: SharedTestClock | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.queues.close(), this.db.$disconnect(), this.testClock?.stop()]);
    this.redis.disconnect();
    this.limiter.redis.disconnect();
  }
}
