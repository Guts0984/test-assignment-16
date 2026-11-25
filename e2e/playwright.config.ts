import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Runs against the full docker compose stack (nginx, two api copies, workers, web, shop stub).
if (existsSync('.env')) process.loadEnvFile('.env');
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
