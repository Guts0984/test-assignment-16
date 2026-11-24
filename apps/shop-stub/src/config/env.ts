// Shop stub configuration: the only reader of process.env in apps/shop-stub.
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    SHOP_STUB_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    SHOP_STUB_API_URL: z.string().url().default('http://nginx/api'),
    SHOP_STUB_API_A_URL: z.string().url().default('http://api-a:3000/api'),
    SHOP_STUB_API_B_URL: z.string().url().default('http://api-b:3000/api'),
    SHOP_STUB_CHAOS: bool.default('false'),
    SHOP_STUB_CHAOS_CANCEL_RATE: z.coerce.number().min(0).max(1).default(0.1),
    SHOP_STUB_CHAOS_SEED: z.coerce.number().int().default(42),
    SHOP_STUB_CHAOS_TIMEOUT_HOLD_MS: z.coerce.number().int().min(0).default(8000),
    SHOP_STUB_CONTROL_ENABLED: bool.default('false'),
    SHOP_STUB_WEBHOOK_MAX_SKEW_SEC: z.coerce.number().int().min(1).default(300),
    SEED_API_KEY_SALT: z.string().min(8),
    SEED_WEBHOOK_SECRET_SALT: z.string().min(8),
    TEST_CONTROL_TOKEN: z.string().min(16).optional(),
  })
  .refine((e) => !e.SHOP_STUB_CONTROL_ENABLED || e.TEST_CONTROL_TOKEN !== undefined, {
    message: 'TEST_CONTROL_TOKEN is required when SHOP_STUB_CONTROL_ENABLED=true',
    path: ['TEST_CONTROL_TOKEN'],
  });

export type StubEnv = z.infer<typeof schema>;

export const parseStubEnv = (source: NodeJS.ProcessEnv): StubEnv => {
  const r = schema.safeParse(source);
  if (!r.success) {
    throw new Error(`Invalid shop-stub configuration:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return Object.freeze(r.data);
};

export const stubEnv = (): StubEnv => parseStubEnv(process.env);
