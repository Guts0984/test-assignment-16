import 'reflect-metadata';
import { createApp, listen } from './bootstrap';
import { apiEnv } from './config/env';

const main = async (): Promise<void> => {
  const env = apiEnv();
  const app = await createApp(env);
  await listen(app, env.API_PORT);
};

main().catch((e: unknown) => {
  process.stderr.write(`api failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
