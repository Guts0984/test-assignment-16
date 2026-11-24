// Writes apps/api/openapi.json from the running app's metadata. CI regenerates it and fails on
// any diff, and the web client is generated from this file.
import 'reflect-metadata';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApi, createApp } from './bootstrap';
import { parseApiEnv } from './config/env';

const main = async (): Promise<void> => {
  const envFile = resolve(__dirname, '../../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const app = await createApp(
    parseApiEnv({ ...process.env, LOG_LEVEL: 'silent', TEST_CLOCK_ENABLED: 'false' }),
  );
  const doc = buildOpenApi(app);
  writeFileSync(resolve(__dirname, '../openapi.json'), `${JSON.stringify(doc, null, 2)}\n`);
  await app.close();
};

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    process.stderr.write(`openapi export failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
