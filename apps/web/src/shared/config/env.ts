// Web configuration. Browser-visible values (NEXT_PUBLIC_*) and server-only values are validated
// separately; this is the only file that reads process.env.
import { z } from 'zod';

const publicSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.string().min(1).default('/api'),
  NEXT_PUBLIC_SOCKET_PATH: z.string().min(1).default('/socket.io'),
});

const serverSchema = z.object({
  API_INTERNAL_URL: z.string().url().default('http://nginx/api'),
});

// Next inlines NEXT_PUBLIC_* only for direct property reads, so each one is named explicitly.
export const publicEnv = Object.freeze(
  publicSchema.parse({
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_SOCKET_PATH: process.env.NEXT_PUBLIC_SOCKET_PATH,
  }),
);

/** Server-only; never import from client components. */
export const serverEnv = () =>
  Object.freeze(serverSchema.parse({ API_INTERNAL_URL: process.env.API_INTERNAL_URL }));
