import { defineConfig } from 'vitest/config';

// Root project: tooling tests (lint rules, repo scripts). Packages have their own configs.
export default defineConfig({
  test: { include: ['scripts/**/*.spec.ts'], environment: 'node', testTimeout: 30_000 },
});
