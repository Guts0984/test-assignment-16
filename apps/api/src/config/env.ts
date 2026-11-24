// API configuration: the only reader of process.env in apps/api. Secrets have no defaults,
// so a missing one stops startup with a readable message.
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (d: number) => z.coerce.number().int().min(0).default(d);

const schema = z
  .object({
    NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    API_PORT: int(3000),
    API_INSTANCE_ID: z.string().min(1).max(32).default('local'),
    DATABASE_URL: z.string().url(),
    DB_POOL_SIZE: int(30),
    REDIS_URL: z.string().url(),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SEC: int(900),
    JWT_REFRESH_TTL_SEC: int(1_209_600),
    COOKIE_SECURE: bool.default('false'),
    API_KEY_PEPPER: z.string().min(32),
    WEBHOOK_SECRET_ENC_KEY: z.string().min(40),
    WEBHOOK_ALLOW_PRIVATE_HOSTS: bool.default('false'),
    CORS_ORIGINS: z.string().default('http://localhost:28080'),
    TRUSTED_PROXY_CIDRS: z.string().default(''),
    BODY_LIMIT_BYTES: int(1_048_576),
    RATE_LIMIT_ENABLED: bool.default('true'),
    RATE_LIMIT_WINDOW_MS: int(60_000),
    RATE_LIMIT_LOGIN_PER_IP: int(20),
    RATE_LIMIT_LOGIN_PER_ACCOUNT: int(10),
    RATE_LIMIT_GENERAL_PER_IP: int(6000),
    RATE_LIMIT_SHOP_API_PER_KEY: int(3000),
    RATE_LIMIT_SHOP_API_PER_IP: int(3000),
    RATE_LIMIT_SCAN_PER_STAFF: int(600),
    RATE_LIMIT_SOCKET_MSG_PER_SEC: int(20),
    SOCKET_PRESENCE_TTL_SEC: int(30),
    AT_RISK_THRESHOLD_MIN: int(60),
    WAVE_INTERVAL_MIN: int(15),
    WAVE_READY_THRESHOLD: int(50),
    WAVE_MAX_ORDERS: int(200),
    WEBHOOK_COALESCE_MS: int(5000),
    PARTIAL_RESERVE_TTL_MIN: int(2880),
    TEST_CLOCK_ENABLED: bool.default('false'),
    TEST_CONTROL_TOKEN: z.string().min(16).optional(),
  })
  .refine((e) => !e.TEST_CLOCK_ENABLED || e.TEST_CONTROL_TOKEN !== undefined, {
    message: 'TEST_CONTROL_TOKEN is required when TEST_CLOCK_ENABLED=true',
    path: ['TEST_CONTROL_TOKEN'],
  });

export type ApiEnv = z.infer<typeof schema>;

export const parseApiEnv = (source: NodeJS.ProcessEnv): ApiEnv => {
  const r = schema.safeParse(source);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid api configuration:\n${issues}`);
  }
  return Object.freeze(r.data);
};

/** Lazily parsed so tests can set process.env before the first read. */
const cache: { env: ApiEnv | null } = { env: null };
export const apiEnv = (): ApiEnv => {
  cache.env ??= parseApiEnv(process.env);
  return cache.env;
};
