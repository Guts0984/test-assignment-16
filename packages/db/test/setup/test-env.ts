// The only reader of process.env in db tests (vitest.config.mts points DATABASE_URL at the test db).
import { z } from 'zod';

export const testEnv = Object.freeze(
  z
    .object({
      DATABASE_URL: z.string().url(),
      SEED_DEMO_PASSWORD: z.string(),
      SEED_API_KEY_SALT: z.string(),
      SEED_WEBHOOK_SECRET_SALT: z.string(),
      API_KEY_PEPPER: z.string(),
      WEBHOOK_SECRET_ENC_KEY: z.string(),
    })
    .parse(process.env),
);

/** A sibling test database for tests that need an empty schema (e.g. the seed). */
export const siblingTestDbUrl = (suffix: string): string => {
  const u = new URL(testEnv.DATABASE_URL);
  u.pathname = `${u.pathname.replace(/_test$/, '')}_${suffix}_test`;
  return u.toString();
};
