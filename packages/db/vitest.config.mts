import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests read the same root .env as docker compose; integration tests use TEST_DATABASE_URL.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const testDb = process.env.TEST_DATABASE_URL;
if (testDb === undefined) throw new Error('TEST_DATABASE_URL is required (cp .env.example .env)');

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['test/**/*.int.spec.ts'],
    environment: 'node',
    server: { deps: { inline: [/@ff\//] } },
    globalSetup: ['test/setup/global-setup.ts'],
    env: { DATABASE_URL: testDb },
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
