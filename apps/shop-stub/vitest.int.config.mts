import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['test/**/*.int.spec.ts'], environment: 'node', server: { deps: { inline: [/@ff\//] } }, testTimeout: 30_000 },
});
