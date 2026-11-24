// Seed / migrate configuration: the only reader of process.env in packages/db.
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SEED_PROFILE: z.enum(['small', 'full']).default('small'),
  SEED_DEMO_PASSWORD: z.string().min(8),
  SEED_API_KEY_SALT: z.string().min(8),
  SEED_WEBHOOK_SECRET_SALT: z.string().min(8),
  SEED_WEBHOOK_BASE_URL: z.string().url().default('http://shop-stub:4000'),
  API_KEY_PEPPER: z.string().min(32),
  WEBHOOK_SECRET_ENC_KEY: z.string().min(40),
});

export type SeedEnv = z.infer<typeof schema>;

export const loadSeedEnv = (source: NodeJS.ProcessEnv = process.env): SeedEnv => {
  const r = schema.safeParse(source);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid seed environment: ${issues}`);
  }
  return Object.freeze(r.data);
};
