// Background jobs with real BullMQ + Redis: three worker copies, exactly-once effects, Redis loss,
// wave triggers, downtime catch-up, nightly failure visibility.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { type Db } from '@ff/db/client';
import { isBalanced, ledgerReport } from '@ff/db/ledger';
import { processAction } from '@ff/core/jobs/run-action';
import { reconcileOnce } from '@ff/core/jobs/reconciler';
import { type Runtime, buildRuntime } from '../../src/infra/deps';
import { parseWorkerEnv } from '../../src/config/env';
import { JobsProcessor } from '../../src/jobs.processor';
import { testEnv } from '../setup/test-env';
import { ENC_KEY, jobDeps, makeDb, testClock, warehouseWorld } from '../world';

let db: Db;
let redis: Redis;
const running: Array<{ p: JobsProcessor; rt: Runtime }> = [];

const env = (over: Record<string, string> = {}) =>
  parseWorkerEnv({
    DATABASE_URL: testEnv.DATABASE_URL,
    REDIS_URL: testEnv.REDIS_URL,
    WEBHOOK_SECRET_ENC_KEY: ENC_KEY,
    LOG_LEVEL: 'silent',
    RECONCILE_INTERVAL_MS: '150',
    WORKER_CONCURRENCY: '4',
    WEBHOOK_ALLOW_PRIVATE_HOSTS: 'true',
    JOB_BACKOFF_MS: '50',
    ...over,
  } as NodeJS.ProcessEnv);

const start = async (n: number, over: Record<string, string> = {}) => {
  const made = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const rt = await buildRuntime(env({ WORKER_ID: `w${running.length + i}`, ...over }));
      const p = new JobsProcessor(rt);
      p.onApplicationBootstrap();
      return { p, rt };
    }),
  );
  running.push(...made);
  return made;
};
const stopAll = async () => {
  await Promise.all(running.splice(0).map((r) => r.p.onApplicationShutdown()));
};

beforeAll(() => {
  db = makeDb();
  redis = new Redis(testEnv.REDIS_URL);
});
afterEach(stopAll);
afterAll(async () => {
  await redis.flushdb();
  redis.disconnect();
  await db.$disconnect();
});

const until = async (cond: () => Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const statuses = async (ids: string[]) =>
  (await db.order.findMany({ where: { id: { in: ids } } })).map((o) => o.status);
const balanced = async () => expect(isBalanced(await ledgerReport(db))).toBe(true);

describe('reservation across three worker copies (acceptance #3, small)', () => {
  it('60 orders for 20 units: exactly 20 reserved, 40 awaiting, every action ran once, ledger balanced', async () => {
    const w = await warehouseWorld(db);
    await w.stock(0, 12);
    await w.stock(1, 8);
    const ids = await Promise.all(Array.from({ length: 60 }, () => w.order(testClock().clock)));
    await start(3);
    await until(async () => (await statuses(ids)).every((s) => s === 'reserved' || s === 'awaiting_stock'));
    const st = await statuses(ids);
    expect(st.filter((s) => s === 'reserved')).toHaveLength(20);
    expect(st.filter((s) => s === 'awaiting_stock')).toHaveLength(40);
    const runs = await db.scheduledAction.findMany({ where: { kind: 'reserve_order', key: { in: ids } } });
    expect(runs.every((r) => r.runCount === 1)).toBe(true);
    expect(await db.stockBalance.count({ where: { skuId: w.sku.id, onHand: { lt: 0 } } })).toBe(0);
    await balanced();
  });
});

describe('Redis loss', () => {
  it('FLUSHALL with pending actions and a due wave timer: everything still happens, nothing twice', async () => {
    const w = await warehouseWorld(db);
    await w.stock(0, 30);
    const ids = await Promise.all(Array.from({ length: 12 }, () => w.order(testClock().clock)));
    // jobs get enqueued, then Redis is wiped before anyone processes them
    const rt = await buildRuntime(env());
    await reconcileOnce({ ...rt.jobDeps, queues: rt.queues, nightlyLocalTime: '02:00' });
    await redis.flushall();
    await rt.stop();
    expect(await statuses(ids)).toEqual(Array(12).fill('received'));
    await start(3);
    await until(async () => (await statuses(ids)).every((s) => s === 'reserved'));
    // the wave timer comes due and Redis is wiped again while workers are live
    await db.$executeRaw`INSERT INTO scheduled_actions (kind, key, due_at, status) VALUES ('wave_timer', ${w.wh.id}, now() - interval '1 minute', 'pending')
                         ON CONFLICT (kind, key) DO UPDATE SET due_at = now() - interval '1 minute', status = 'pending'`;
    await redis.flushall();
    await until(async () => (await statuses(ids)).every((s) => s === 'in_wave'));
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
    expect(await db.pickTask.count({ where: { warehouseId: w.wh.id } })).toBe(12);
    const timer = await db.scheduledAction.findFirstOrThrow({ where: { kind: 'wave_timer', key: w.wh.id } });
    expect(timer.status).toBe('pending');
    expect(timer.dueAt.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    await redis.flushall();
    await new Promise((r) => setTimeout(r, 800));
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
    expect(
      (await db.scheduledAction.findMany({ where: { kind: 'reserve_order', key: { in: ids } } })).every(
        (r) => r.runCount === 1,
      ),
    ).toBe(true);
    await balanced();
  });
});

describe('waves', () => {
  it('the ready-count threshold forms a wave at once; below it the timer decides (49 / 50 / 51 scaled to 4 / 5 / 6)', async () => {
    const w = await warehouseWorld(db);
    await w.stock(0, 40);
    const tc = testClock();
    const d = jobDeps(db, tc.clock, {
      settings: {
        webhookCoalesceMs: 5000,
        partialReserveTtlMin: 2880,
        waveReadyThreshold: 5,
        waveMaxOrders: 200,
        waveIntervalMin: 15,
      },
    });
    const drain = async () => {
      const { drainDue } = await import('@ff/core/jobs/run-action');
      return drainDue(d, 'w', ['reserve_order', 'wave_check']);
    };
    const first = await Promise.all(Array.from({ length: 4 }, () => w.order(tc.clock)));
    await drain();
    expect(await statuses(first)).toEqual(Array(4).fill('reserved'));
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(0);
    const fifth = await w.order(tc.clock);
    await drain();
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
    expect(await statuses([...first, fifth])).toEqual(Array(5).fill('in_wave'));
    const sixth = await w.order(tc.clock);
    await drain();
    expect(await statuses([sixth])).toEqual(['reserved']);
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
  });

  it('timer boundary: 14:59.999 forms nothing, 15:00 forms the wave; a manual wave and the timer never double-form', async () => {
    const w = await warehouseWorld(db);
    await w.stock(0, 10);
    const tc = testClock('2026-11-24T10:00:00Z');
    const d = jobDeps(db, tc.clock);
    const ids = await Promise.all(Array.from({ length: 3 }, () => w.order(tc.clock)));
    const { drainDue } = await import('@ff/core/jobs/run-action');
    await drainDue(d, 'w', ['reserve_order']);
    await db.$executeRaw`INSERT INTO scheduled_actions (kind, key, due_at, status) VALUES ('wave_timer', ${w.wh.id}, '2026-11-24T10:15:00Z', 'pending')
                         ON CONFLICT (kind, key) DO UPDATE SET due_at = '2026-11-24T10:15:00Z', status = 'pending'`;
    tc.set('2026-11-24T10:14:59.999Z');
    await drainDue(d, 'w', ['wave_timer']);
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(0);
    tc.set('2026-11-24T10:15:00.000Z');
    const { formWave } = await import('@ff/core/floor/waves');
    const [timer, manual] = await Promise.all([
      drainDue(d, 'w', ['wave_timer']),
      formWave(d, newFx(), w.wh.id, 'manual', null),
    ]);
    expect(timer).toBeGreaterThanOrEqual(1);
    expect(manual.ok).toBe(true);
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
    expect(await db.waveOrder.count({ where: { orderId: { in: ids }, active: true } })).toBe(3);
    const next = await db.scheduledAction.findFirstOrThrow({ where: { kind: 'wave_timer', key: w.wh.id } });
    expect(next.dueAt.toISOString()).toBe('2026-11-24T10:30:00.000Z');
  });

  it('downtime catch-up: three missed slots fire the timer once, then the next slot is one interval ahead', async () => {
    const w = await warehouseWorld(db);
    await w.stock(0, 10);
    const tc = testClock('2026-11-24T10:00:00Z');
    const d = jobDeps(db, tc.clock);
    await w.order(tc.clock);
    const { drainDue } = await import('@ff/core/jobs/run-action');
    await drainDue(d, 'w', ['reserve_order']);
    await db.$executeRaw`INSERT INTO scheduled_actions (kind, key, due_at, status) VALUES ('wave_timer', ${w.wh.id}, '2026-11-24T10:15:00Z', 'pending')
                         ON CONFLICT (kind, key) DO UPDATE SET due_at = '2026-11-24T10:15:00Z', status = 'pending'`;
    tc.set('2026-11-24T11:02:00Z');
    await drainDue(d, 'w', ['wave_timer']);
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
    await drainDue(d, 'w', ['wave_timer']);
    expect(await db.wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
    const next = await db.scheduledAction.findFirstOrThrow({ where: { kind: 'wave_timer', key: w.wh.id } });
    expect(next.dueAt.toISOString()).toBe('2026-11-24T11:17:00.000Z');
  });
});

describe('nightly and failures', () => {
  it('a ledger mismatch fails the nightly job until it is dead and visible; fixing the data and rerunning succeeds once', async () => {
    const w = await warehouseWorld(db);
    await w.stock(0, 5);
    const tc = testClock('2026-11-24T01:00:00Z');
    const d = jobDeps(db, tc.clock, {
      jobs: { leaseMs: 30_000, maxAttempts: 2, backoffBaseMs: 10, backoffMaxMs: 10 },
    });
    await db.$executeRaw`UPDATE stock_balances SET on_hand = on_hand + 1 WHERE location_id = ${w.cells[0]?.id}::uuid`;
    await db.$executeRaw`INSERT INTO scheduled_actions (kind, key, due_at, status) VALUES ('nightly', ${w.wh.id}, ${tc.clock.now()}, 'pending')
                         ON CONFLICT (kind, key) DO UPDATE SET due_at = ${tc.clock.now()}, status = 'pending', attempts = 0`;
    const row = await db.scheduledAction.findFirstOrThrow({ where: { kind: 'nightly', key: w.wh.id } });
    const out: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      out.push(await processAction(d, row.id, 'w'));
      tc.advance(1000);
    }
    expect(out).toEqual(['retry', 'dead']);
    expect((await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } })).lastError).toMatch(
      /ledger mismatch/,
    );
    await db.$executeRaw`UPDATE stock_balances SET on_hand = on_hand - 1 WHERE location_id = ${w.cells[0]?.id}::uuid`;
    const { rerunDeadAction } = await import('@ff/core/scheduled-actions');
    expect(await rerunDeadAction(db, row.id, tc.clock.now())).toBe(true);
    expect(await processAction(d, row.id, 'w')).toBe('done');
    const after = await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('pending');
    expect(after.dueAt.getTime()).toBeGreaterThan(tc.clock.now().getTime());
  });

  it('shelf-life revalidation re-reserves an order whose batch slipped below the shop minimum', async () => {
    const w = await warehouseWorld(db);
    const tc = testClock('2026-11-24T08:00:00Z');
    const d = jobDeps(db, tc.clock);
    await db.shop.update({ where: { id: w.shop.id }, data: { minShelfLifeDays: 30 } });
    await db.sku.update({ where: { id: w.sku.id }, data: { tracksExpiry: true } });
    const near = await db.batch.create({
      data: { skuId: w.sku.id, code: 'N', expiresOn: new Date('2026-12-30') },
    });
    const far = await db.batch.create({
      data: { skuId: w.sku.id, code: 'F', expiresOn: new Date('2027-06-30') },
    });
    const { insertMovements } = await import('@ff/db/ledger');
    const { withTx } = await import('@ff/db/tx');
    const { randomUUID } = await import('node:crypto');
    for (const [i, b] of [near, far].entries()) {
      await withTx(db, (tx) =>
        insertMovements(tx, [
          {
            groupId: randomUUID(),
            kind: 'receipt',
            warehouseId: w.wh.id,
            locationId: w.cells[i]?.id ?? '',
            skuId: w.sku.id,
            batchId: b.id,
            onHandDelta: 5,
            reservedDelta: 0,
            qty: 5,
            fromLocationId: null,
            toLocationId: w.cells[i]?.id ?? '',
            docType: 't',
            docId: 't',
            actorType: 'system',
            actorId: null,
            at: new Date(),
          },
        ]),
      );
    }
    const id = await w.order(tc.clock);
    const { drainDue } = await import('@ff/core/jobs/run-action');
    await drainDue(d, 'w', ['reserve_order']);
    expect((await db.orderReservation.findFirstOrThrow({ where: { orderId: id } })).batchId).toBe(near.id);
    tc.set('2026-12-10T08:00:00Z');
    const { revalidateShelfLife } = await import('@ff/core/jobs/maintenance');
    const r = await revalidateShelfLife(d, newFx(), w.wh.id);
    expect(r.ok && r.value.orders).toBe(1);
    expect((await db.orderReservation.findFirstOrThrow({ where: { orderId: id } })).batchId).toBe(far.id);
    await balanced();
  });
});

const newFx = () => ({ realtime: [], actions: [] });
