import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC keeps decorator metadata, which Vitest's default transform drops (CLAUDE.md).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['src/**/*.spec.ts'], environment: 'node', server: { deps: { inline: [/@ff\//] } } },
});
