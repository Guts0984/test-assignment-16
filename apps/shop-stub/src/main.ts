import { deriveSeedApiKey, deriveSeedWebhookSecret } from '@ff/shared/crypto/secrets';
import { buildStub } from './app';
import { stubEnv } from './config/env';
import { createSender } from './sender';
import { createStore } from './store';

const SEEDED_SHOPS = ['SHOP1', 'SHOP2', 'SHOP3', 'SHOP4', 'SHOP5'] as const;

const main = async (): Promise<void> => {
  const env = stubEnv();
  const store = createStore();
  for (const code of SEEDED_SHOPS) {
    store.registerShop({
      code,
      apiKey: deriveSeedApiKey(env.SEED_API_KEY_SALT, code),
      webhookSecret: deriveSeedWebhookSecret(env.SEED_WEBHOOK_SECRET_SALT, code),
    });
  }
  const chaos = {
    enabled: env.SHOP_STUB_CHAOS,
    cancelRate: env.SHOP_STUB_CHAOS_CANCEL_RATE,
    failEvery: 5,
    timeoutHoldMs: env.SHOP_STUB_CHAOS_TIMEOUT_HOLD_MS,
  };
  const sender = createSender({
    fetch,
    apiUrl: env.SHOP_STUB_API_URL,
    apiAUrl: env.SHOP_STUB_API_A_URL,
    apiBUrl: env.SHOP_STUB_API_B_URL,
    chaos: () => chaos,
    seed: env.SHOP_STUB_CHAOS_SEED,
  });
  const app = buildStub({
    store,
    sender,
    chaos,
    now: () => new Date(),
    maxSkewSec: env.SHOP_STUB_WEBHOOK_MAX_SKEW_SEC,
    controlToken: env.SHOP_STUB_CONTROL_ENABLED ? (env.TEST_CONTROL_TOKEN ?? null) : null,
  });
  await app.listen({ port: env.SHOP_STUB_PORT, host: '0.0.0.0' });
  const stop = () => void app.close().finally(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdout.write(`shop stub listening on ${env.SHOP_STUB_PORT}\n`);
};

main().catch((e: unknown) => {
  process.stderr.write(`shop stub failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
