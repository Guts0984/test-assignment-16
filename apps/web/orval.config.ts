import { defineConfig } from 'orval';

// The client is generated from the committed OpenAPI document (apps/api/openapi.json) and never
// edited by hand. CI regenerates it and fails on any diff.
export default defineConfig({
  fulfillment: {
    input: '../api/openapi.json',
    output: {
      target: './src/shared/api/generated/endpoints.ts',
      schemas: './src/shared/api/generated/model',
      client: 'react-query',
      httpClient: 'fetch',
      mode: 'tags-split',
      clean: true,
      prettier: false,
      override: {
        mutator: { path: './src/shared/api/mutator.ts', name: 'apiFetch' },
        query: { useQuery: true, useMutation: true },
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
});
