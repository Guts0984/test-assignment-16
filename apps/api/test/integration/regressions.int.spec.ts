// Regressions for bugs found in review: each test fails without its fix.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect } from 'socket.io-client';
import { makeStaff, makeWarehouse, PASSWORD } from '../setup/fixtures';
import { startTestApp, type TestApp } from '../setup/app';
import {
  drain,
  expectBalanced,
  key,
  newSku,
  orderStatus,
  placeOrder,
  stockUp,
  world,
  type World,
} from '../setup/floor';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ RATE_LIMIT_ENABLED: 'false' });
});
afterAll(async () => t.close());

/** Order placed, reserved, waved, picked and packed; returns its id and number. */
const packedOrder = async (w: World) => {
  const sku = await newSku(w);
  await stockUp(w, sku, 'A-001', 5);
  const orderId = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
  await drain(t);
  await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
  const task = (
    await w.api.post(`/api/warehouses/${w.wh.id}/tasks/next`, undefined, { token: w.picker1.token })
  ).body;
  await w.api.post(
    `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan-cell`,
    { cellCode: 'A-001' },
    { token: w.picker1.token },
  );
  await w.api.post(
    `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
    { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, qty: 1, idempotencyKey: key() },
    { token: w.picker1.token },
  );
  const pack = () =>
    w.api.post(
      `/api/warehouses/${w.wh.id}/packing`,
      { orderRef: task.orderNumber, idempotencyKey: key() },
      { token: w.packer.token },
    );
  expect((await pack()).status).toBe(200);
  return { orderId, number: task.orderNumber as string, pack };
};

describe('shipping and packing', () => {
  it('an order named explicitly is not shipped before its ship day', async () => {
    const w = await world(t);
    const o = await packedOrder(w);
    await t.db.$executeRaw`UPDATE orders SET ship_day = CURRENT_DATE + 3 WHERE id = ${o.orderId}::uuid`;
    const early = await w.api.post(
      `/api/warehouses/${w.wh.id}/shipments`,
      { orderIds: [o.orderId], idempotencyKey: key() },
      { token: w.store.token },
    );
    expect(early.body).toMatchObject({ shipped: [], skipped: [o.orderId] });
    expect(await orderStatus(t, o.orderId)).toBe('packed');
    await t.db.$executeRaw`UPDATE orders SET ship_day = CURRENT_DATE - 1 WHERE id = ${o.orderId}::uuid`;
    const due = await w.api.post(
      `/api/warehouses/${w.wh.id}/shipments`,
      { orderIds: [o.orderId], idempotencyKey: key() },
      { token: w.store.token },
    );
    expect(due.body.shipped).toEqual([o.orderId]);
  });

  it('scanning a packed order again reprints it (same answer, one packed event); a shipped one says so', async () => {
    const w = await world(t);
    const o = await packedOrder(w);
    const again = await o.pack();
    expect([again.status, again.body.orderId]).toEqual([200, o.orderId]);
    const events = await t.db.webhookEvent.count({ where: { stream: `order:${o.orderId}` } });
    await o.pack();
    expect(await t.db.webhookEvent.count({ where: { stream: `order:${o.orderId}` } })).toBe(events);
    await t.db.$executeRaw`UPDATE orders SET ship_day = CURRENT_DATE - 1 WHERE id = ${o.orderId}::uuid`;
    await w.api.post(
      `/api/warehouses/${w.wh.id}/shipments`,
      { orderIds: [o.orderId], idempotencyKey: key() },
      { token: w.store.token },
    );
    const late = await o.pack();
    expect([late.status, late.body.error.code]).toEqual([422, 'INVALID_TRANSITION']);
    expect(late.body.error.message).toContain('already shipped');
  });
});

describe('order visibility', () => {
  it('a picker cannot list or read orders (customer data); a shift lead can', async () => {
    const w = await world(t);
    const o = await packedOrder(w);
    for (const url of ['/api/orders', `/api/orders/${o.orderId}`])
      expect((await w.api.get(url, { token: w.picker1.token })).status).toBe(403);
    expect((await w.api.get(`/api/orders/${o.orderId}`, { token: w.lead.token })).status).toBe(200);
  });
});

describe('transfers', () => {
  it('one batch sent from two cells is received once: reporting 10 books 10, reporting 5 books 5', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    const a = await stockUp(w, sku, 'A-001', 5);
    const b = await stockUp(w, sku, 'A-002', 5);
    expect(a.batchId).toBe(b.batchId);
    const dest = await makeWarehouse(w.api, w.admin, { cells: 2 });
    const destStore = await makeStaff(w.api, w.admin, [{ role: 'storekeeper', warehouseId: dest.id }]);
    const cells = await t.db.location.findMany({
      where: { warehouseId: w.wh.id, code: { in: ['A-001', 'A-002'] } },
    });
    const send = async () =>
      (
        await w.api.post(
          `/api/warehouses/${w.wh.id}/transfers`,
          {
            toWarehouseId: dest.id,
            lines: cells.map((c) => ({ cellId: c.id, skuId: sku.id, batchId: a.batchId, qty: 5 })),
            idempotencyKey: key(),
          },
          { token: w.store.token },
        )
      ).body.transferId as string;
    const first = await send();
    const receive = (id: string, qty: number) =>
      w.api.post(
        `/api/warehouses/${dest.id}/transfers/${id}/receive`,
        { lines: [{ skuId: sku.id, batchId: a.batchId, qty }], idempotencyKey: key() },
        { token: destStore.token },
      );
    expect((await receive(first, 12)).status).toBe(400);
    expect((await receive(first, 5)).body).toEqual({ received: 5, missing: 5 });
    await expectBalanced(t);
    const rest = await t.db.stockBalance.aggregate({
      _sum: { onHand: true },
      where: { warehouseId: w.wh.id, skuId: sku.id },
    });
    expect(rest._sum.onHand ?? 0).toBe(0);
  });
});

describe('refresh grace window', () => {
  it('two tabs presenting one token together both get a session; a later reuse revokes the family', async () => {
    const graceApp = await startTestApp({ RATE_LIMIT_ENABLED: 'false', REFRESH_REUSE_GRACE_SEC: '10' });
    try {
      const w = await world(graceApp);
      const staff = await makeStaff(w.api, w.admin, []);
      const login = await w.api.post('/api/auth/login', { email: staff.email, password: PASSWORD });
      const old = login.body.refreshToken as string;
      const [a, b] = await Promise.all([
        w.api.post('/api/auth/refresh', { refreshToken: old }),
        w.api.post('/api/auth/refresh', { refreshToken: old }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await w.api.get('/api/auth/me', { token: a.body.accessToken })).status).toBe(200);
      // after the window the same old token is theft: everything of the family dies
      await graceApp.db.$executeRaw`UPDATE refresh_tokens SET used_at = used_at - interval '60 seconds'`;
      const late = await w.api.post('/api/auth/refresh', { refreshToken: old });
      expect([late.status, late.body.error.code]).toEqual([401, 'TOKEN_REUSED']);
      expect((await w.api.post('/api/auth/refresh', { refreshToken: a.body.refreshToken })).status).toBe(401);
    } finally {
      await graceApp.close();
    }
  });
});

describe('refresh grace limit', () => {
  it('one token cannot mint unlimited sessions inside the window: 1 rotation + 5 replays, the rest are theft', async () => {
    const graceApp = await startTestApp({ RATE_LIMIT_ENABLED: 'false', REFRESH_REUSE_GRACE_SEC: '10' });
    try {
      const w = await world(graceApp);
      const staff = await makeStaff(w.api, w.admin, []);
      const old = (await w.api.post('/api/auth/login', { email: staff.email, password: PASSWORD })).body
        .refreshToken as string;
      const res = await Promise.all(
        Array.from({ length: 20 }, () => w.api.post('/api/auth/refresh', { refreshToken: old })),
      );
      expect(res.filter((r) => r.status === 200)).toHaveLength(6);
      // the refused ones counted as reuse: the family is revoked, so none of the sessions survives
      const sessions = res.filter((r) => r.status === 200);
      for (const r of sessions)
        expect((await w.api.get('/api/auth/me', { token: r.body.accessToken })).status).toBe(401);
    } finally {
      await graceApp.close();
    }
  });
});

describe('socket timers', () => {
  it('sockets that drop right after connecting leave no re-check timer behind', async () => {
    const w = await world(t);
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await new Promise((r) => setTimeout(r, 300));
    const before = timers();
    const sockets = Array.from({ length: 40 }, () =>
      connect(t.base, {
        path: '/socket.io',
        transports: ['websocket'],
        auth: { token: w.lead.token },
        reconnection: false,
      }),
    );
    // cut each transport the moment it opens, while the server is still checking the token
    await Promise.all(
      sockets.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.io.on('open', () => {
              setImmediate(() => {
                s.io.engine.close();
                resolve();
              });
            });
            s.on('connect_error', () => resolve());
          }),
      ),
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(timers() - before).toBeLessThan(10);
  });
});
