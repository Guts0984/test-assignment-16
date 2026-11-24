// The only reader of process.env in worker tests.
import { z } from 'zod';

export const testEnv = Object.freeze(
  z.object({ DATABASE_URL: z.string().url(), REDIS_URL: z.string().url() }).passthrough().parse(process.env),
);
export const rawEnv = (): NodeJS.ProcessEnv => ({ ...process.env });
