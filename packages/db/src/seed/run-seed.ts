// CLI: migrate container runs `node dist/seed/run-seed.js` after `prisma migrate deploy`.
import { createDb } from '../client';
import { loadSeedEnv } from '../config/env';
import { runSeed } from './seed';

const main = async (): Promise<void> => {
  const env = loadSeedEnv();
  const db = createDb({ url: env.DATABASE_URL, poolSize: 2 });
  try {
    const r = await runSeed(db, {
      profile: env.SEED_PROFILE,
      demoPassword: env.SEED_DEMO_PASSWORD,
      apiKeySalt: env.SEED_API_KEY_SALT,
      webhookSecretSalt: env.SEED_WEBHOOK_SECRET_SALT,
      webhookBaseUrl: env.SEED_WEBHOOK_BASE_URL,
      apiKeyPepper: env.API_KEY_PEPPER,
      webhookEncKey: env.WEBHOOK_SECRET_ENC_KEY,
      log: (m) => process.stdout.write(`${m}\n`),
    });
    process.stdout.write(`seed ${r.ran ? `applied (${r.profile}) in ${r.ms} ms` : 'skipped'}\n`);
  } finally {
    await db.$disconnect();
  }
};

main().catch((e: unknown) => {
  process.stderr.write(`seed failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
