import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests: the Nest app in-process against real Postgres (own database) and real Redis.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const db = (process.env.TEST_DATABASE_URL ?? '').replace(/_test$/, '_api_test');
const redis = (process.env.TEST_REDIS_URL ?? '').replace(/\/\d+$/, '/3');
process.env.DATABASE_URL = db;
process.env.REDIS_URL = redis;

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['test/integration/**/*.int.spec.ts'],
    environment: 'node',
    server: { deps: { inline: [/@ff\//] } },
    globalSetup: ['test/setup/global-setup.ts'],
    env: { DATABASE_URL: db, REDIS_URL: redis, NODE_ENV: 'test' },
    // Files share one database and drain each other's due background actions: run them one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
