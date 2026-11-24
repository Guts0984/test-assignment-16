// Idempotent seed: runs once per database (seed_runs marker), all in one transaction.
import { hashPassword } from '../password';
import { encryptSecret, hashApiKey, parseApiKey } from '@ff/shared/crypto/secrets';
import { type Db } from '../client';
import { PROFILES, type SeedProfile } from './profiles';
import {
  SEED_SHOPS,
  SEED_STAFF,
  SEED_WAREHOUSES,
  seedShopSecrets,
  seedShopUserEmail,
  seedUuid,
} from './credentials';
import { seedStatements } from './sql';

export type SeedConfig = {
  readonly profile: 'small' | 'full';
  readonly demoPassword: string;
  readonly apiKeySalt: string;
  readonly webhookSecretSalt: string;
  readonly webhookBaseUrl: string;
  readonly apiKeyPepper: string;
  readonly webhookEncKey: string;
  readonly now?: Date;
  readonly log?: (msg: string) => void;
};

export type SeedOutcome = { readonly ran: boolean; readonly profile: SeedProfile['name']; readonly ms: number };

export const runSeed = async (db: Db, cfg: SeedConfig): Promise<SeedOutcome> => {
  const started = Date.now();
  const log = cfg.log ?? (() => undefined);
  const existing = await db.seedRun.findFirst();
  if (existing !== null) {
    log(`seed already applied (${existing.profile}), skipping`);
    return { ran: false, profile: cfg.profile, ms: 0 };
  }
  const profile = PROFILES[cfg.profile];
  const now = cfg.now ?? new Date();
  const passwordHash = await hashPassword(cfg.demoPassword);

  await db.$transaction(
    async (tx) => {
      // Serialises concurrent seeders (two containers starting at once); the loser sees the marker.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4242)`;
      if ((await tx.seedRun.count()) > 0) return;
      const [{ n } = { n: 0 }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM stock_movements`;
      if (n > 0) throw new Error('refusing to seed a database that already has stock movements');

      await tx.shop.createMany({
        data: SEED_SHOPS.map((s) => {
          const sec = seedShopSecrets(cfg.apiKeySalt, cfg.webhookSecretSalt, s.code);
          return {
            id: seedUuid(`shop:${s.s}`),
            code: s.code,
            name: s.name,
            webhookUrl: `${cfg.webhookBaseUrl}/webhooks/${s.code}`,
            webhookSecretEnc: encryptSecret(cfg.webhookEncKey, sec.webhookSecret),
            minShelfLifeDays: s.minShelfLifeDays,
          };
        }),
      });
      await tx.shopApiKey.createMany({
        data: SEED_SHOPS.map((s) => {
          const { apiKey } = seedShopSecrets(cfg.apiKeySalt, cfg.webhookSecretSalt, s.code);
          const parsed = parseApiKey(apiKey);
          if (parsed === null) throw new Error('derived API key is malformed');
          return { shopId: seedUuid(`shop:${s.s}`), prefix: parsed.prefix, hash: hashApiKey(cfg.apiKeyPepper, apiKey), label: 'demo' };
        }),
      });
      await tx.shopUser.createMany({
        data: SEED_SHOPS.map((s) => ({
          shopId: seedUuid(`shop:${s.s}`),
          email: seedShopUserEmail(s.s),
          name: `${s.name} manager`,
          passwordHash,
        })),
      });
      await tx.staff.createMany({
        data: SEED_STAFF.map((p) => ({ id: seedUuid(`staff:${p.email}`), email: p.email, name: p.name, passwordHash })),
      });
      await tx.staffRoleAssignment.createMany({
        data: SEED_STAFF.flatMap((p) =>
          p.roles.map((r) => ({
            staffId: seedUuid(`staff:${p.email}`),
            role: r.role,
            warehouseId: r.w === null ? null : seedUuid(`wh:${SEED_WAREHOUSES[r.w - 1]?.w ?? 0}`),
          })),
        ),
      });
      for (const [i, stmt] of seedStatements({ now, profile }).entries()) {
        const t = Date.now();
        await tx.$executeRaw(stmt);
        log(`seed step ${i + 1}: ${Date.now() - t} ms`);
      }
      await tx.seedRun.create({ data: { profile: profile.name } });
    },
    { timeout: 60 * 60_000, maxWait: 60_000 },
  );
  return { ran: true, profile: profile.name, ms: Date.now() - started };
};
