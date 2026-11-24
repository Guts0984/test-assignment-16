import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Adversarial suite: real nginx + two api copies + three workers + shop stub, attacked over the network.
// One fork and no module isolation keep a single stack for all spec files.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['test/attacker/specs/all.adv.spec.ts'],
    environment: 'node',
    server: { deps: { inline: [/@ff\//] } },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true, isolate: false } },
    fileParallelism: false,
    globalSetup: ['test/attacker/harness/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
