// Acceptance #14 and #15: live updates across api copies, and every isolation boundary attacked
// with direct requests, another shop's API key and sockets, through both copies.
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCopy, client, ledger, must, socket, until } from '../harness/attacker';
import { ensureStack, getStack } from '../harness/global';
import {
  key,
  login,
  newSku,
  newWorld,
  nextIp,
  placeOrder,
  settled,
  startPickingTask,
  stockUp,
  uid,
  type World,
} from '../harness/scenarios';

beforeAll(async () => void (await ensureStack()));
afterAll(async () => ledger.assertBalanced());
const db = () => getStack().db;

describe('acceptance #14: shift lead on copy A, picker on copy B', () => {
  it('a scan and a status change reach the lead in under a second', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await settled([id]);
    await until(
      async () => (await db().order.findUniqueOrThrow({ where: { id } })).status === 'reserved',
      30_000,
      100,
    );
    const lead = await socket({ auth: w.lead.token, apiCopy: 'a', sourceIp: w.ip });
    expect(lead.ready()).toBe(true);
    const wave = await w.lead.api.post(`/api/warehouses/${w.wh.id}/waves`);
    expect(wave.status).toBe(201);
    const task = (
      await apiCopy('b', { sourceIp: w.ip, auth: w.picker1.token }).post(
        `/api/warehouses/${w.wh.id}/tasks/next`,
      )
    ).body;
    const t0 = Date.now();
    const r = await apiCopy('b', { sourceIp: w.ip, auth: w.picker1.token }).post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, idempotencyKey: key() },
    );
    expect(r.status).toBe(200);
    await until(() => lead.events.some((e) => e.event === 'pick.scan'), 1000, 10);
    const scanEvent = must(lead.events.find((e) => e.event === 'pick.scan'));
    expect(scanEvent.at - t0).toBeLessThan(1000);
    await until(
      () => lead.events.some((e) => e.event === 'order.status' && e.payload.status === 'picked'),
      1000,
      10,
    );
    expect(
      must(lead.events.find((e) => e.event === 'order.status' && e.payload.status === 'picked')).at - t0,
    ).toBeLessThan(1000);
    lead.close();
  });

  it('a shop on copy B sees its stock change live after a receipt on copy A', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    const shop = await socket({ auth: w.shop.apiKey, apiCopy: 'b', sourceIp: w.ip });
    expect(shop.ready()).toBe(true);
    const t0 = Date.now();
    await stockUp(w, sku, 'A-001', 3);
    await until(() => shop.events.some((e) => e.event === 'stock.changed'), 5000, 20);
    expect(must(shop.events.find((e) => e.event === 'stock.changed')).at - t0).toBeLessThan(5000);
    shop.close();
  });
});

describe('acceptance #15: other shop, other warehouse, other picker', () => {
  let a: World;
  let b: World;
  const ids = { sku: '', orderA: '', task: '', line: '', barcode: '', code: '' };
  beforeAll(async () => {
    a = await newWorld();
    b = await newWorld();
    const skuA = await newSku(a);
    await stockUp(a, skuA, 'A-001', 10);
    ids.sku = skuA.id;
    ids.orderA = await placeOrder(a, [{ sku: skuA.code, qty: 1 }]);
    await settled([ids.orderA]);
    const task = await startPickingTask(a);
    ids.task = task.id;
    ids.line = task.lines[0].lineId;
    ids.barcode = skuA.barcode;
    ids.code = skuA.code;
  });

  const through = (fn: (api: ReturnType<typeof apiCopy>, who: 'a' | 'b') => Promise<unknown>) =>
    Promise.all([
      fn(apiCopy('a', { sourceIp: nextIp() }), 'a'),
      fn(apiCopy('b', { sourceIp: nextIp() }), 'b'),
    ]);

  it("shop B (key and cabinet login) cannot read, cancel or label shop A's order, SKU or stock", async () => {
    const cabinet = await (async () => {
      await db().shopUser.create({
        data: {
          shopId: b.shop.id,
          email: `shop-${uid()}@adv.local`.toLowerCase(),
          name: 'B',
          passwordHash: (await db().staff.findFirstOrThrow()).passwordHash,
        },
      });
      const u = await db().shopUser.findFirstOrThrow({ where: { shopId: b.shop.id } });
      return login(client({ sourceIp: nextIp() }), u.email);
    })();
    for (const token of [b.shop.apiKey, cabinet]) {
      const cl = client({ sourceIp: nextIp(), auth: token });
      expect((await cl.get(`/api/shop/v1/orders/${ids.orderA}`)).status).toBe(404);
      expect((await cl.get(`/api/shop/v1/skus/${ids.sku}`)).status).toBe(404);
      expect((await cl.post(`/api/shop/v1/orders/${ids.orderA}/cancel`, {})).status).toBe(404);
      expect((await cl.get(`/api/shop/v1/orders/${ids.orderA}/label`)).status).toBe(404);
      expect((await cl.get(`/api/shop/v1/orders?shopId=${a.shop.id}`)).status).toBe(403);
      const list = await cl.get(
        `/api/shop/v1/orders?q=${(await db().order.findUniqueOrThrow({ where: { id: ids.orderA } })).externalNumber}`,
      );
      expect(list.body.items).toEqual([]);
      const stock = await cl.get(`/api/shop/v1/stock?q=${ids.code}`);
      expect(stock.body.items).toEqual([]);
    }
    expect(
      await db()
        .order.findUniqueOrThrow({ where: { id: ids.orderA } })
        .then((o) => o.status),
    ).not.toBe('cancelled');
  });

  it("a forged shopId, another shop's order number or another shop's barcode cannot attach anything to shop A", async () => {
    const cl = client({ sourceIp: nextIp(), auth: b.shop.apiKey });
    const forged = await cl.post('/api/shop/v1/orders', {
      externalNumber: uid('F'),
      deliveryMethod: 'standard',
      shopId: a.shop.id,
      address: { name: 'x', line1: 'y', city: 'z', postalCode: '00-001', country: 'PL' },
      lines: [{ sku: ids.code, qty: 1 }],
    });
    expect(forged.status).toBe(400);
    const foreignSku = await cl.post('/api/shop/v1/orders', {
      externalNumber: uid('F'),
      deliveryMethod: 'standard',
      address: { name: 'x', line1: 'y', city: 'z', postalCode: '00-001', country: 'PL' },
      lines: [{ sku: ids.code, qty: 1 }],
    });
    expect([foreignSku.status, foreignSku.body.error.code]).toEqual([422, 'UNKNOWN_SKU']);
  });

  it('staff of warehouse B have no access to warehouse A: dashboard, tasks, counts, receipts, putaway, reports, orders', async () => {
    const paths = [
      ['get', `/api/warehouses/${a.wh.id}/dashboard`, b.lead],
      ['get', `/api/warehouses/${a.wh.id}/tasks`, b.lead],
      ['get', `/api/warehouses/${a.wh.id}/tasks/${ids.task}`, b.lead],
      ['post', `/api/warehouses/${a.wh.id}/waves`, b.lead],
      ['post', `/api/warehouses/${a.wh.id}/tasks/next`, b.picker1],
      ['get', `/api/warehouses/${a.wh.id}/counts`, b.lead],
      ['get', `/api/warehouses/${a.wh.id}/putaway/pending`, b.store],
      ['post', `/api/warehouses/${a.wh.id}/receipts`, b.store],
      ['get', `/api/warehouses/${a.wh.id}/cells`, b.lead],
      ['get', `/api/orders?warehouseId=${a.wh.id}`, b.lead],
      ['get', `/api/reports/summary?from=2026-01-01&to=2026-02-01&warehouseId=${a.wh.id}`, b.lead],
      ['post', `/api/warehouses/${a.wh.id}/shipments`, b.store],
      ['post', `/api/warehouses/${a.wh.id}/packing`, b.packer],
    ] as const;
    await through(async (api) => {
      for (const [m, p, who] of paths) {
        const r = await api.withAuth(who.token).call(m.toUpperCase(), p, m === 'post' ? { body: {} } : {});
        expect([p, r.status]).toEqual([p, 403]);
      }
      const order = await api.withAuth(b.lead.token).get(`/api/orders/${ids.orderA}`);
      expect(order.status).toBe(404);
    });
  });

  it("a picker cannot read or scan another picker's task, nor take it, on either copy", async () => {
    await through(async (api) => {
      const other = api.withAuth(a.picker2.token);
      expect((await other.get(`/api/warehouses/${a.wh.id}/tasks/${ids.task}`)).status).toBe(404);
      const r = await other.post(`/api/warehouses/${a.wh.id}/tasks/${ids.task}/scan`, {
        lineId: ids.line,
        cellCode: 'A-001',
        barcode: ids.barcode,
        idempotencyKey: key(),
      });
      expect([r.status, r.body.error.code]).toEqual([422, 'TASK_NOT_ASSIGNED']);
      expect(
        (
          await other.post(`/api/warehouses/${a.wh.id}/tasks/${ids.task}/shortage`, {
            lineId: ids.line,
            foundQty: 0,
            idempotencyKey: key(),
          })
        ).body.error.code,
      ).toBe('TASK_NOT_ASSIGNED');
    });
    expect((await db().pickLine.findUniqueOrThrow({ where: { id: ids.line } })).pickedQty).toBe(0);
  });

  it('role escalation and mass assignment are refused: a picker cannot approve or start waves, extra fields are rejected', async () => {
    expect((await a.picker1.api.post(`/api/warehouses/${a.wh.id}/waves`)).status).toBe(403);
    expect((await a.store.api.post(`/api/warehouses/${a.wh.id}/waves`)).status).toBe(403);
    expect(
      (await a.picker1.api.post(`/api/warehouses/${a.wh.id}/counts/${ids.task}/approve`, { approve: true }))
        .status,
    ).toBe(403);
    expect(
      (
        await a.lead.api.post('/api/admin/staff', {
          email: 'x@y.zz',
          name: 'n',
          password: '12345678',
          roles: [],
        })
      ).status,
    ).toBe(403);
    const payload = (extra: object) => ({
      lineId: ids.line,
      cellCode: 'A-001',
      barcode: ids.barcode,
      idempotencyKey: key(),
      ...extra,
    });
    for (const extra of [
      { pickedQty: 99 },
      { status: 'done' },
      { approvedBy: a.lead.id },
      { warehouseId: b.wh.id },
      { reserved: 0 },
      { version: 7 },
      { role: 'admin' },
    ]) {
      const r = await a.picker1.api.post(`/api/warehouses/${a.wh.id}/tasks/${ids.task}/scan`, payload(extra));
      expect([r.status, Object.keys(extra)[0]]).toEqual([400, Object.keys(extra)[0]]);
    }
    const patch = await a.as.patch(`/api/admin/staff/${a.lead.id}`, { id: b.lead.id, role: 'admin' });
    expect(patch.status).toBe(400);
  });

  it('sockets: foreign rooms, forged tokens and API keys of the wrong kind are refused, whichever copy', async () => {
    for (const which of ['a', 'b'] as const) {
      expect((await socket({ auth: undefined, apiCopy: which })).ready()).toBe(false);
      expect((await socket({ auth: 'garbage', apiCopy: which })).ready()).toBe(false);
      const forged = jwt.sign(
        { sub: a.lead.id, typ: 'staff', fam: a.lead.id },
        'wrong-secret-wrong-secret-wrong-secret',
        { algorithm: 'HS256' },
      );
      expect((await socket({ auth: forged, apiCopy: which })).ready()).toBe(false);
      const shopB = await socket({ auth: b.shop.apiKey, apiCopy: which });
      expect(shopB.ready()).toBe(true);
      expect(must(shopB.events.find((e) => e.event === 'ready')).payload.rooms).toEqual([
        `shop:${b.shop.id}`,
      ]);
      expect(await shopB.s.emitWithAck('subscribe', { warehouseId: a.wh.id })).toMatchObject({
        ok: false,
        error: 'FORBIDDEN',
      });
      const leadB = await socket({ auth: b.lead.token, apiCopy: which });
      expect(await leadB.s.emitWithAck('subscribe', { warehouseId: a.wh.id })).toMatchObject({
        ok: false,
        error: 'FORBIDDEN',
      });
      for (const s of [shopB, leadB]) s.close();
    }
  });

  it("shop sockets never receive another shop's events nor internal warehouse data", async () => {
    const sb = await socket({ auth: b.shop.apiKey, apiCopy: 'a' });
    const sa = await socket({ auth: a.shop.apiKey, apiCopy: 'b' });
    const skuA2 = await newSku(a);
    await stockUp(a, skuA2, 'A-002', 4);
    const o = await placeOrder(a, [{ sku: skuA2.code, qty: 1 }]);
    await settled([o]);
    const task = await startPickingTask(a, a.picker2);
    await a.picker2.api.post(`/api/warehouses/${a.wh.id}/tasks/${task.id}/shortage`, {
      lineId: task.lines[0].lineId,
      foundQty: 0,
      idempotencyKey: key(),
    });
    await until(() => sa.events.some((e) => e.event === 'order.status'), 5000, 50);
    await new Promise((r) => setTimeout(r, 400));
    expect(sb.events.filter((e) => e.event !== 'ready')).toEqual([]);
    const seen = JSON.stringify(sa.events);
    expect(seen).not.toMatch(/shortage|picker|staff|adjust|pick\.scan/i);
    sa.close();
    sb.close();
  });

  it('a socket flood from one connection is throttled and does not disturb another client', async () => {
    const flooder = await socket({ auth: a.lead.token, apiCopy: 'a', sourceIp: nextIp() });
    const calm = await socket({ auth: a.lead.token, apiCopy: 'a', sourceIp: nextIp() });
    const acks = await Promise.all(
      Array.from({ length: 120 }, () =>
        flooder.s
          .emitWithAck('subscribe', { warehouseId: a.wh.id })
          .catch(() => ({ ok: false, error: 'DROPPED' })),
      ),
    );
    expect(acks.filter((x: { ok: boolean }) => !x.ok).length).toBeGreaterThan(60);
    expect(calm.s.connected).toBe(true);
    expect(await calm.s.emitWithAck('subscribe', { warehouseId: a.wh.id })).toMatchObject({ ok: true });
    flooder.close();
    calm.close();
  });
});
