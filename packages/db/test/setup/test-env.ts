// The only reader of process.env in db tests (vitest.config.mts points DATABASE_URL at the test db).
import { z } from 'zod';

export const testEnv = Object.freeze(z.object({ DATABASE_URL: z.string().url() }).parse(process.env));
