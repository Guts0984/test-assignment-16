// Worker configuration: the only reader of process.env in apps/worker.
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (d: number) => z.coerce.number().int().min(0).default(d);

const schema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DB_POOL_SIZE: int(20),
  REDIS_URL: z.string().url(),
  WEBHOOK_SECRET_ENC_KEY: z.string().min(40),
  WORKER_CONCURRENCY: int(5),
  WORKER_ID: z.string().min(1).max(64).optional(),
  RECONCILE_INTERVAL_MS: int(1000),
  JOB_LEASE_MS: int(30_000),
  JOB_MAX_ATTEMPTS: int(5),
  JOB_BACKOFF_MS: int(1000),
  WAVE_INTERVAL_MIN: int(15),
  WAVE_READY_THRESHOLD: int(50),
  WAVE_MAX_ORDERS: int(200),
  PARTIAL_RESERVE_TTL_MIN: int(2880),
  NIGHTLY_LOCAL_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('02:00'),
  WEBHOOK_COALESCE_MS: int(5000),
  WEBHOOK_TIMEOUT_MS: int(5000),
  WEBHOOK_MAX_ATTEMPTS: int(10),
  WEBHOOK_BACKOFF_BASE_MS: int(1000),
  WEBHOOK_BACKOFF_MAX_MS: int(60_000),
  WEBHOOK_ALLOW_PRIVATE_HOSTS: bool.default('false'),
  TEST_CLOCK_ENABLED: bool.default('false'),
});

export type WorkerEnv = z.infer<typeof schema>;

export const parseWorkerEnv = (source: NodeJS.ProcessEnv): WorkerEnv => {
  const r = schema.safeParse(source);
  if (!r.success) {
    throw new Error(
      `Invalid worker configuration:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  return Object.freeze(r.data);
};

export const workerEnv = (): WorkerEnv => parseWorkerEnv(process.env);
