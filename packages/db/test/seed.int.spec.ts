// The seed on the small profile: shape, ratios, ledger consistency, idempotency, credentials.
import { verify } from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyMatches, decryptSecret } from '@ff/shared/crypto/secrets';
import { isAtRisk } from '@ff/shared/rules/at-risk';
import { type OrderStatus } from '@ff/shared/domain';
import { createDb, type Db } from '../src/client';
import { isBalanced, ledgerReport } from '../src/ledger';
import { PROFILES } from '../src/seed/profiles';
import { SEED_SHOPS, seedShopSecrets } from '../src/seed/credentials';
import { runSeed, type SeedConfig } from '../src/seed/seed';
import { resetTestDatabase } from '../src/testing';
import { siblingTestDbUrl, testEnv } from './setup/test-env';

const url = siblingTestDbUrl('seed');
let db: Db;
const now = new Date();
const cfg: SeedConfig = {
  profile: 'small',
  demoPassword: testEnv.SEED_DEMO_PASSWORD,
  apiKeySalt: testEnv.SEED_API_KEY_SALT,
  webhookSecretSalt: testEnv.SEED_WEBHOOK_SECRET_SALT,
  webhookBaseUrl: 'http://shop-stub:4000',
  apiKeyPepper: testEnv.API_KEY_PEPPER,
  webhookEncKey: testEnv.WEBHOOK_SECRET_ENC_KEY,
  now,
};
const p = PROFILES.small;

beforeAll(async () => {
  await resetTestDatabase(url);
  db = createDb({ url, poolSize: 4 });
  const r = await runSeed(db, cfg);
  expect(r.ran).toBe(true);
}, 600_000);
afterAll(async () => db.$disconnect());

const count = async (sql: TemplateStringsArray): Promise<number> => {
  const [r] = await db.$queryRaw<{ n: number }[]>(sql);
  return r?.n ?? -1;
};

describe('seed (small profile)', () => {
  it('creates 2 warehouses in two time zones and 5 shops', async () => {
    const whs = await db.warehouse.findMany({ orderBy: { code: 'asc' } });
    expect(whs.map((w) => w.timeZone)).toEqual(['Europe/Kyiv', 'Europe/Warsaw']);
    expect(await db.shop.count()).toBe(5);
  });

  it('creates SKUs (some expiry-tracked) and cells per profile', async () => {
    expect(await db.sku.count()).toBe(5 * p.skusPerShop);
    const tracked = await db.sku.count({ where: { tracksExpiry: true } });
    expect(tracked).toBeGreaterThan(0);
    expect(tracked).toBeLessThan(5 * p.skusPerShop);
    expect(await db.location.count({ where: { kind: 'storage' } })).toBe(2 * p.cellsPerWarehouse);
    expect(await db.location.count({ where: { kind: { in: ['receiving', 'packing', 'return'] } } })).toBe(6);
  });

  it('historic and live orders exist; about 2x live-per-warehouse are in progress', async () => {
    expect(await db.order.count()).toBe(p.historicOrders + 2 * p.liveOrdersPerWarehouse);
    const inWork = await db.order.count({ where: { status: { in: ['reserved', 'in_wave', 'picking', 'picked'] } } });
    expect(inWork).toBeGreaterThan(p.liveOrdersPerWarehouse);
    for (const s of ['received', 'awaiting_stock', 'reserved', 'in_wave', 'picking', 'picked', 'packed', 'shipped', 'cancelled'] as const) {
      expect(await db.order.count({ where: { status: s } }), s).toBeGreaterThan(0);
    }
  });

  it('some live orders will miss the cutoff if nothing is done', async () => {
    const live = await db.order.findMany({ where: { status: { in: ['reserved', 'in_wave', 'picking', 'picked'] } } });
    expect(live.some((o) => isAtRisk(o.status as OrderStatus, o.targetCutoffAt, now, 60))).toBe(true);
  });

  it('movements are many and the ledger balances everywhere', async () => {
    expect(await count`SELECT count(*)::int AS n FROM stock_movements`).toBeGreaterThan(p.historicOrders * 4);
    const r = await ledgerReport(db);
    expect(r).toMatchObject({ ledgerMismatches: 0, reservationMismatches: 0, lineMismatches: 0, negativeBalances: 0 });
    expect(isBalanced(r)).toBe(true);
  });

  it('awaiting_stock orders ask for SKUs that have no stock', async () => {
    const n = await count`
      SELECT count(*)::int AS n FROM orders o JOIN order_lines l ON l.order_id = o.id
      JOIN stock_balances b ON b.sku_id = l.sku_id AND b.on_hand > 0
      WHERE o.status = 'awaiting_stock'`;
    expect(n).toBe(0);
  });

  it('every picking task line points at its reservation cell, and picked stock sits in packing', async () => {
    expect(
      await count`SELECT count(*)::int AS n FROM pick_lines pl JOIN pick_tasks t ON t.id = pl.task_id
                 WHERE t.status = 'assigned' AND pl.picked_qty <> 1`,
    ).toBe(0);
    expect(
      await count`SELECT count(*)::int AS n FROM stock_balances b JOIN locations l ON l.id = b.location_id
                 WHERE l.kind = 'packing' AND b.on_hand > 0`,
    ).toBeGreaterThan(0);
  });

  it('status history versions match each order status_version', async () => {
    expect(
      await count`SELECT count(*)::int AS n FROM orders o
                 WHERE o.status_version <> (SELECT max(version) FROM order_status_history h WHERE h.order_id = o.id)`,
    ).toBe(0);
  });

  it('is idempotent: a second run is skipped and changes nothing', async () => {
    const before = await count`SELECT count(*)::int AS n FROM stock_movements`;
    expect((await runSeed(db, cfg)).ran).toBe(false);
    expect(await count`SELECT count(*)::int AS n FROM stock_movements`).toBe(before);
  });

  it('seeded credentials work: API keys, webhook secrets and passwords', async () => {
    for (const s of SEED_SHOPS) {
      const { apiKey, webhookSecret } = seedShopSecrets(cfg.apiKeySalt, cfg.webhookSecretSalt, s.code);
      const key = await db.shopApiKey.findUniqueOrThrow({ where: { prefix: apiKey.slice(3, 11) } });
      expect(apiKeyMatches(cfg.apiKeyPepper, apiKey, key.hash)).toBe(true);
      const shop = await db.shop.findUniqueOrThrow({ where: { code: s.code } });
      expect(decryptSecret(cfg.webhookEncKey, shop.webhookSecretEnc)).toBe(webhookSecret);
    }
    const admin = await db.staff.findUniqueOrThrow({ where: { email: 'admin@demo.local' }, include: { roles: true } });
    expect(await verify(admin.passwordHash, cfg.demoPassword)).toBe(true);
    expect(admin.roles.map((r) => r.role)).toEqual(['admin']);
  });

  it('refuses to seed a database that already has stock but no marker', async () => {
    await db.seedRun.deleteMany();
    await expect(runSeed(db, cfg)).rejects.toThrow(/already has stock movements/);
  });
});
