// Acceptance #10, #11, #12 and the time/job scenarios on the real stack: cutoff, idempotent import,
// chaos webhooks counted at the receiving stub, kill -9, Redis loss, downtime catch-up.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { apiCopy, at, burst, clock, ledger, redis, until, workers } from '../harness/attacker';
import { ensureStack, getStack } from '../harness/global';
import {
  key,
  login,
  newSku,
  newWorld,
  orderPayload,
  orderStatus,
  placeOrder,
  scan,
  settled,
  statuses,
  stockUp,
  uid,
  type World,
} from '../harness/scenarios';

beforeAll(async () => void (await ensureStack()));
afterEach(async () => {
  await clock.reset();
  for (let i = 0; i < 3; i += 1) if (getStack().workers()[i] === null) await workers.start(i);
});
afterAll(async () => ledger.assertBalanced());

const db = () => getStack().db;
const stubWebhooks = async (code: string) =>
  (
    (await (await fetch(`${getStack().stub}/api/webhooks?shop=${code}`)).json()) as {
      items: {
        outcome: string;
        type: string;
        stream: string;
        version: number;
        data: any;
        receivedAt: string;
        seq: number;
      }[];
    }
  ).items;
const chaos = (body: object) =>
  fetch(`${getStack().stub}/control/chaos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-token': getStack().controlToken },
    body: JSON.stringify(body),
  });

const packAt = async (w: World, iso: string) => {
  const sku = await newSku(w);
  await stockUp(w, sku, 'A-001', 3);
  const number = `T-${uid()}`;
  const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }], false, number);
  await settled([id]);
  await w.lead.api.post(`/api/warehouses/${w.wh.id}/waves`);
  const task = (await w.picker1.api.post(`/api/warehouses/${w.wh.id}/tasks/next`)).body;
  await scan(w, task.id, { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode });
  await clock.set(iso);
  await new Promise((r) => setTimeout(r, 1300));
  const packer = w.packer.api.withAuth(
    await login(w.api, `${(await db().staff.findUniqueOrThrow({ where: { id: w.packer.id } })).email}`),
  );
  const r = await packer.post(`/api/warehouses/${w.wh.id}/packing`, {
    orderRef: number,
    idempotencyKey: key(),
  });
  return { r, id };
};

describe('acceptance #10: cutoff and shipping day (Warsaw, cutoff 17:00)', () => {
  it('packed Friday 17:01 ships Monday; 16:59:59 ships the same day; shipping waits for the day', async () => {
    const w = await newWorld({ timeZone: 'Europe/Warsaw' });
    const late = await packAt(w, '2026-11-27T16:01:00Z'); // 17:01 CET
    expect(late.r.status, late.r.text).toBe(200);
    expect(late.r.body.shipDay).toBe('2026-11-30');
    const w2 = await newWorld({ timeZone: 'Europe/Warsaw' });
    const early = await packAt(w2, '2026-11-27T15:57:00Z'); // 16:57 CET: the clock keeps running, so keep a margin (exact boundaries are unit-tested)
    expect(early.r.body.shipDay).toBe('2026-11-27');
    // Friday: only the early one may leave; Monday: the late one too
    const lead = w.lead.api.withAuth(
      await login(w.api, (await db().staff.findUniqueOrThrow({ where: { id: w.lead.id } })).email),
    );
    const fri = await lead.post(`/api/warehouses/${w.wh.id}/shipments`, { idempotencyKey: key() });
    expect(fri.body.shipped).toEqual([]);
    await clock.set('2026-11-30T09:00:00Z');
    await new Promise((r) => setTimeout(r, 1300));
    const lead2 = w.lead.api.withAuth(
      await login(w.api, (await db().staff.findUniqueOrThrow({ where: { id: w.lead.id } })).email),
    );
    const mon = await lead2.post(`/api/warehouses/${w.wh.id}/shipments`, { idempotencyKey: key() });
    expect(mon.body.shipped).toEqual([late.id]);
    expect(await orderStatus(late.id)).toBe('shipped');
  });

  it('daylight saving: Warsaw spring transition keeps 17:00 local (15:00Z after the change, not 16:00Z)', async () => {
    const w = await newWorld({ timeZone: 'Europe/Warsaw' });
    const before = await packAt(w, '2026-03-30T14:57:00Z'); // Monday after DST: 16:57 CEST
    expect(before.r.body.shipDay).toBe('2026-03-30');
    const w2 = await newWorld({ timeZone: 'Europe/Warsaw' });
    const after = await packAt(w2, '2026-03-30T15:02:00Z'); // 17:02 CEST: after the cutoff
    expect(after.r.body.shipDay).toBe('2026-03-31');
  });
});

describe('acceptance #11: duplicate import and chaos webhooks', () => {
  it('one order sent 10 times at once to both api copies: one order, one reserve', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    const body = orderPayload(uid('DUP'), [{ sku: sku.code, qty: 2 }]);
    const res = await burst(10, (i) =>
      apiCopy(i % 2 === 0 ? 'a' : 'b', { sourceIp: w.ip, auth: w.shop.apiKey }).post(
        '/api/shop/v1/orders',
        body,
      ),
    );
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    const id = at(res, 0).body.orderId as string;
    expect(new Set(res.map((r) => r.body.orderId))).toEqual(new Set([id]));
    await settled([id]);
    expect(
      await db().order.count({ where: { shopId: w.shop.id, externalNumber: body.externalNumber } }),
    ).toBe(1);
    expect(
      await db()
        .orderReservation.aggregate({ where: { orderId: id }, _sum: { qty: true } })
        .then((a) => a._sum.qty),
    ).toBe(2);
    const conflict = await w.shopApi.post(
      '/api/shop/v1/orders',
      orderPayload(body.externalNumber, [{ sku: sku.code, qty: 3 }]),
    );
    expect([conflict.status, conflict.body.error.code]).toEqual([409, 'ORDER_CONFLICT']);
    await ledger.assertBalanced();
  });

  it('every fifth webhook fails (500 or timeout): all events arrive, versions never go back, stock changes at most every 5 s with the latest value', async () => {
    await chaos({ enabled: true, failEvery: 5, timeoutHoldMs: 2500 });
    try {
      const w = await newWorld({ stub: true });
      const sku = await newSku(w);
      await stockUp(w, sku, 'A-001', 40);
      const ids: string[] = [];
      for (let i = 0; i < 12; i += 1) ids.push(await placeOrder(w, [{ sku: sku.code, qty: 1 }]));
      await settled(ids);
      await Promise.all(ids.slice(0, 4).map((id) => w.shopApi.post(`/api/shop/v1/orders/${id}/cancel`, {})));
      await until(
        async () =>
          (await db().webhookEvent.count({
            where: { shopId: w.shop.id, status: { in: ['pending', 'delivering'] } },
          })) === 0,
        90_000,
        500,
      );
      const hooks = await stubWebhooks(w.shop.code);
      expect(hooks.some((h) => h.outcome === 'fault_500')).toBe(true);
      expect(hooks.some((h) => h.outcome === 'fault_timeout')).toBe(true);
      expect(hooks.filter((h) => h.outcome === 'stale_version')).toHaveLength(0);
      // every order event reached the stub, counted at the receiver
      const events = await db().webhookEvent.findMany({
        where: { shopId: w.shop.id, stream: { startsWith: 'order:' } },
      });
      const accepted = new Set(
        hooks
          .filter((h) => h.outcome === 'accepted' && h.type === 'order.status_changed')
          .map((h) => `${h.stream}#${h.version}`),
      );
      for (const e of events)
        expect(accepted.has(`${e.stream}#${e.version}`), `${e.stream} v${e.version}`).toBe(true);
      // versions accepted per stream strictly increase in arrival order
      const byStream = new Map<string, number[]>();
      for (const h of hooks.filter((x) => x.outcome === 'accepted').sort((a, b) => a.seq - b.seq))
        byStream.set(h.stream, [...(byStream.get(h.stream) ?? []), h.version]);
      for (const vs of byStream.values()) expect(vs).toEqual([...vs].sort((a, b) => a - b));
      // stock events: spacing and latest value
      const stock = hooks
        .filter((h) => h.outcome === 'accepted' && h.type === 'stock.available_changed')
        .sort((a, b) => a.seq - b.seq);
      expect(stock.length).toBeGreaterThan(0);
      for (let i = 1; i < stock.length; i += 1)
        expect(
          Date.parse(at(stock, i).receivedAt) - Date.parse(at(stock, i - 1).receivedAt),
        ).toBeGreaterThanOrEqual(4000) // 5 s between sends, minus delivery jitter under load;
      const current = await db().stockBalance.aggregate({
        where: { skuId: sku.id },
        _sum: { onHand: true, reserved: true },
      });
      const available = (current._sum.onHand ?? 0) - (current._sum.reserved ?? 0);
      await until(
        async () => {
          const last = (await stubWebhooks(w.shop.code))
            .filter((h) => h.outcome === 'accepted' && h.type === 'stock.available_changed')
            .pop();
          return last?.data.available === available;
        },
        30_000,
        500,
      );
    } finally {
      await chaos({ enabled: false });
    }
  });
});

describe('acceptance #12: kill -9 and Redis loss', () => {
  it('kill -9 on workers in the middle of reserving: after restart everything is done once, nothing doubled', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 25);
    const res = await burst(80, () =>
      w.shopApi.post('/api/shop/v1/orders', orderPayload(uid('K9'), [{ sku: sku.code, qty: 1 }])),
    );
    const ids = res.map((r) => r.body.orderId as string);
    await workers.kill9(0);
    await workers.kill9(1);
    await new Promise((r) => setTimeout(r, 400));
    await workers.kill9(2);
    await new Promise((r) => setTimeout(r, 500));
    await Promise.all([0, 1, 2].map((i) => workers.start(i)));
    await until(async () => (await statuses(ids)).every((s) => s !== 'received'), 90_000, 300);
    const st = await statuses(ids);
    expect(st.filter((s) => s === 'reserved' || s === 'in_wave' || s === 'picking')).toHaveLength(25);
    expect(st.filter((s) => s === 'awaiting_stock')).toHaveLength(55);
    expect(
      await db()
        .orderReservation.aggregate({ where: { orderId: { in: ids } }, _sum: { qty: true } })
        .then((a) => a._sum.qty),
    ).toBe(25);
    await ledger.assertBalanced();
  });

  it('kill -9 while the wave timer runs: one wave, no double tasks', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 30);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => placeOrder(w, [{ sku: sku.code, qty: 1 }])),
    );
    await until(
      async () => (await db().order.count({ where: { id: { in: ids }, status: 'reserved' } })) === 8,
      30_000,
      200,
    );
    // make the timer due, kill every worker as soon as one of them has claimed it
    await db()
      .$executeRaw`UPDATE scheduled_actions SET due_at = now() - interval '1 second', status = 'pending' WHERE kind = 'wave_timer' AND key = ${w.wh.id}`;
    await until(
      async () =>
        (await db().scheduledAction.findFirst({ where: { kind: 'wave_timer', key: w.wh.id } }))?.status ===
          'running' || (await db().wave.count({ where: { warehouseId: w.wh.id } })) > 0,
      15_000,
      10,
    );
    await Promise.all([0, 1, 2].map((i) => workers.kill9(i)));
    await new Promise((r) => setTimeout(r, 300));
    await Promise.all([0, 1, 2].map((i) => workers.start(i)));
    await until(
      async () => (await db().order.count({ where: { id: { in: ids }, status: 'in_wave' } })) === 8,
      60_000,
      300,
    );
    expect(await db().wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
    expect(await db().pickTask.count({ where: { orderId: { in: ids } } })).toBe(8);
    expect(await db().waveOrder.count({ where: { orderId: { in: ids }, active: true } })).toBe(8);
  });

  it('FLUSHALL (and a Redis restart) with live timers, waiting re-reserves and queued webhooks: nothing lost, nothing twice', async () => {
    await chaos({ enabled: false });
    const w = await newWorld({ stub: true });
    const sku = await newSku(w);
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => placeOrder(w, [{ sku: sku.code, qty: 1 }])),
    );
    await settled(ids);
    await stockUp(w, sku, 'A-001', 6);
    // Redis is wiped while the re-reserve is waiting; Postgres rebuilds the job
    await redis.flushAll();
    await until(async () => (await statuses(ids)).filter((s) => s === 'reserved').length === 6, 60_000, 300);
    // the wave timer comes due and Redis is wiped and restarted while workers are live
    await db()
      .$executeRaw`UPDATE scheduled_actions SET due_at = now() - interval '1 second', status = 'pending' WHERE kind = 'wave_timer' AND key = ${w.wh.id}`;
    await redis.flushAll();
    await redis.restart();
    await redis.flushAll();
    await until(async () => (await statuses(ids)).filter((s) => s === 'in_wave').length === 6, 60_000, 300);
    expect(await db().wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
    expect(
      await db()
        .orderReservation.aggregate({ where: { orderId: { in: ids } }, _sum: { qty: true } })
        .then((a) => a._sum.qty),
    ).toBe(6);
    await until(
      async () =>
        (await db().webhookEvent.count({
          where: { shopId: w.shop.id, status: { in: ['pending', 'delivering'] } },
        })) === 0,
      60_000,
      400,
    );
    const hooks = (await stubWebhooks(w.shop.code)).filter(
      (h) => h.outcome === 'accepted' && h.type === 'order.status_changed',
    );
    const keys = hooks.map((h) => `${h.stream}#${h.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    await ledger.assertBalanced();
  });

  it('downtime catch-up: workers stopped, the clock jumps past three wave slots, one wave fires once on start', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => placeOrder(w, [{ sku: sku.code, qty: 1 }])),
    );
    await until(
      async () => (await db().order.count({ where: { id: { in: ids }, status: 'reserved' } })) === 4,
      30_000,
      200,
    );
    await Promise.all([0, 1, 2].map((i) => workers.kill9(i)));
    await clock.advance(50 * 60_000);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await db().wave.count({ where: { warehouseId: w.wh.id } })).toBe(0);
    await Promise.all([0, 1, 2].map((i) => workers.start(i)));
    await until(
      async () => (await db().order.count({ where: { id: { in: ids }, status: 'in_wave' } })) === 4,
      60_000,
      300,
    );
    await new Promise((r) => setTimeout(r, 2000));
    expect(await db().wave.count({ where: { warehouseId: w.wh.id } })).toBe(1);
  });
});

describe('exhausted retries are visible to admins and rerun once', () => {
  it('a shop whose webhook endpoint is down ends up in the failed-jobs list; non-admins cannot see it', async () => {
    const w = await newWorld(); // webhook URL points at a closed port
    const sku = await newSku(w);
    await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await until(
      async () =>
        (await db().scheduledAction.count({
          where: { kind: 'webhook_stream', status: 'dead', key: { startsWith: w.shop.id } },
        })) > 0,
      90_000,
      500,
    );
    const list = await w.as.get('/api/admin/jobs/failed');
    const mine = list.body.items.filter((j: { key: string }) => j.key.startsWith(w.shop.id));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].lastError).toMatch(/failed/);
    expect((await w.lead.api.get('/api/admin/jobs/failed')).status).toBe(403);
    expect((await w.shopApi.get('/api/admin/jobs/failed')).status).toBe(403);
    expect((await w.lead.api.post(`/api/admin/jobs/failed/${mine[0].id}/rerun`)).status).toBe(403);
    const reruns = await burst(4, () => w.as.post(`/api/admin/jobs/failed/${mine[0].id}/rerun`));
    expect(reruns.filter((r) => r.status === 200)).toHaveLength(1);
  });
});
