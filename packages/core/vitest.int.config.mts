import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests: real Postgres (own database) and real Redis (own db index), from the root .env.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const db = (process.env.TEST_DATABASE_URL ?? '').replace(/_test$/, '_core_test');
const redis = (process.env.TEST_REDIS_URL ?? '').replace(/\/\d+$/, '/2');
// Global setup runs in this process: point it at the test database too.
process.env.DATABASE_URL = db;
process.env.REDIS_URL = redis;

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['test/**/*.int.spec.ts'],
    environment: 'node',
    server: { deps: { inline: [/@ff\//] } },
    globalSetup: ['test/setup/global-setup.ts'],
    env: { DATABASE_URL: db, REDIS_URL: redis },
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
