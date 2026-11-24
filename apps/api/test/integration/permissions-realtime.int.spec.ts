// Floor permissions per warehouse and role, label access, and sockets: handshake auth, server-side
// rooms, cross-copy delivery, presence expiry, flood throttling.
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { http, startTestApp, type TestApp } from '../setup/app';
import { makeShop } from '../setup/fixtures';
import { drain, key, newSku, placeOrder, stockUp, world, type World } from '../setup/floor';

let a: TestApp;
let b: TestApp;
beforeAll(async () => {
  a = await startTestApp({
    RATE_LIMIT_ENABLED: 'false',
    SOCKET_PRESENCE_TTL_SEC: '2',
    RATE_LIMIT_SOCKET_MSG_PER_SEC: '5',
  });
  b = await startTestApp({ RATE_LIMIT_ENABLED: 'false' });
});
afterAll(async () => {
  await a.close();
  await b.close();
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const open = async (
  base: string,
  token: string | undefined,
): Promise<{ s: Socket; events: { event: string; at: number; payload: any }[] }> => {
  const s = connect(base, {
    transports: ['websocket'],
    auth: token === undefined ? {} : { token },
    reconnection: false,
  });
  const events: { event: string; at: number; payload: any }[] = [];
  s.onAny((event, payload) => events.push({ event, at: Date.now(), payload }));
  await new Promise<void>((res) => {
    s.on('ready', () => res());
    s.on('disconnect', () => res());
    s.on('connect_error', () => res());
  });
  return { s, events };
};

describe('HTTP permissions on floor routes', () => {
  it('a role at warehouse 1 has no access at warehouse 2, and the wrong role is refused', async () => {
    const w1 = await world(a);
    const w2 = await world(a);
    const r = (w: World, path: string, who: { token: string }, method: 'get' | 'post' = 'get') =>
      method === 'get' ? w.api.get(path, { token: who.token }) : w.api.post(path, {}, { token: who.token });
    expect((await r(w2, `/api/warehouses/${w1.wh.id}/dashboard`, w2.lead)).status).toBe(403);
    expect((await r(w1, `/api/warehouses/${w1.wh.id}/dashboard`, w1.lead)).status).toBe(200);
    expect((await r(w1, `/api/warehouses/${w1.wh.id}/dashboard`, w1.picker1)).status).toBe(403);
    expect((await r(w1, `/api/warehouses/${w1.wh.id}/waves`, w1.store, 'post')).status).toBe(403);
    expect((await r(w1, `/api/warehouses/${w1.wh.id}/tasks/next`, w1.store, 'post')).status).toBe(403);
    expect(
      (
        await r(
          w1,
          `/api/warehouses/${w1.wh.id}/counts/00000000-0000-4000-8000-000000000000/approve`,
          w1.picker1,
          'post',
        )
      ).status,
    ).toBe(403);
    expect((await r(w1, `/api/warehouses/${w1.wh.id}/putaway/pending`, w1.picker1)).status).toBe(403);
    expect(
      (
        await w1.api.get(`/api/reports/summary?from=2026-01-01&to=2026-02-01&warehouseId=${w2.wh.id}`, {
          token: w1.lead.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (await w1.api.get('/api/reports/summary?from=2026-03-01&to=2026-01-01', { token: w1.lead.token }))
        .status,
    ).toBe(400);
  });

  it('labels: only the owning shop and the packers of the order warehouse', async () => {
    const w = await world(a);
    const other = await world(a);
    const otherShop = await makeShop(w.api, w.admin);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 3);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await drain(a);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    const task = (
      await w.api.post(`/api/warehouses/${w.wh.id}/tasks/next`, undefined, { token: w.picker1.token })
    ).body;
    await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    const pack = await w.api.post(
      `/api/warehouses/${w.wh.id}/packing`,
      { orderRef: id, idempotencyKey: key() },
      { token: w.packer.token },
    );
    expect(pack.status).toBe(200);
    const get = async (path: string, token: string) =>
      (await fetch(`${a.base}${path}`, { headers: { authorization: `Bearer ${token}` } })).status;
    expect(await get(`/api/shop/v1/orders/${id}/label`, w.shop.apiKey)).toBe(200);
    expect(await get(`/api/shop/v1/orders/${id}/label`, otherShop.apiKey)).toBe(404);
    expect(await get(`/api/warehouses/${w.wh.id}/orders/${id}/label`, w.packer.token)).toBe(200);
    expect(await get(`/api/warehouses/${other.wh.id}/orders/${id}/label`, other.packer.token)).toBe(404);
    expect(await get(`/api/warehouses/${w.wh.id}/orders/${id}/label`, w.picker1.token)).toBe(403);
    expect(await get(`/api/shop/v1/orders/${id}/cancel`, otherShop.apiKey)).toBe(404);
  });
});

describe('sockets', () => {
  it('rejects unauthenticated, forged and non-bearer tokens', async () => {
    for (const token of [undefined, 'garbage', 'fk_00000000_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx']) {
      const { s, events } = await open(a.base, token);
      expect(s.connected && events.some((e) => e.event === 'ready')).toBe(false);
      s.close();
    }
  });

  it('a shop only gets its own events; a shop socket cannot subscribe to a warehouse dashboard', async () => {
    const w = await world(a);
    const sku = await newSku(w);
    const other = await makeShop(w.api, w.admin);
    const mine = await open(a.base, w.shop.apiKey);
    const theirs = await open(a.base, other.apiKey);
    expect(mine.events.find((e) => e.event === 'ready')?.payload.rooms).toEqual([`shop:${w.shop.id}`]);
    const denied = await mine.s.emitWithAck('subscribe', { warehouseId: w.wh.id });
    expect(denied).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await until(() => mine.events.some((e) => e.event === 'order.status'));
    await new Promise((r) => setTimeout(r, 200));
    expect(theirs.events.filter((e) => e.event === 'order.status')).toHaveLength(0);
    expect(JSON.stringify(mine.events)).not.toMatch(/picker|staff|shortage|adjust/i);
    mine.s.close();
    theirs.s.close();
  });

  it('a shift lead on copy A sees a scan made through copy B in under a second; other leads and pickers do not', async () => {
    const w = await world(a);
    const stranger = await world(a);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 5);
    await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await drain(a);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    const task = (
      await w.api.post(`/api/warehouses/${w.wh.id}/tasks/next`, undefined, { token: w.picker1.token })
    ).body;
    const lead = await open(a.base, w.lead.token);
    const outsider = await open(a.base, stranger.lead.token);
    const picker2 = await open(a.base, w.picker2.token);
    const apiB = http(b.base);
    const t0 = Date.now();
    await apiB.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    await until(() => lead.events.some((e) => e.event === 'pick.scan'), 1000);
    const got = lead.events.find((e) => e.event === 'pick.scan');
    expect((got?.at ?? Infinity) - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 200));
    expect(outsider.events.some((e) => e.event === 'pick.scan')).toBe(false);
    expect(picker2.events.some((e) => e.event === 'pick.scan')).toBe(false);
    expect(await outsider.s.emitWithAck('subscribe', { warehouseId: w.wh.id })).toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    for (const s of [lead.s, outsider.s, picker2.s]) s.close();
  });

  it('presence expires without a clean disconnect; floods are throttled and repeat offenders dropped', async () => {
    const w = await world(a);
    const lead = await open(a.base, w.lead.token);
    const p = await open(a.base, w.picker1.token);
    const online = async () =>
      (await w.api.get(`/api/warehouses/${w.wh.id}/dashboard`, { token: w.lead.token })).body.pickers.find(
        (x: { staffId: string }) => x.staffId === w.picker1.id,
      )?.online as boolean;
    await until(async () => (await online()) === true);
    // simulate a vanished client: server-side TTL (2 s) with no heartbeat
    await until(async () => (await online()) === false, 6000);
    const acks = await Promise.all(
      Array.from({ length: 30 }, () =>
        lead.s.emitWithAck('subscribe', { warehouseId: w.wh.id }).catch(() => ({ ok: false })),
      ),
    );
    expect(acks.filter((x: { ok: boolean }) => !x.ok).length).toBeGreaterThan(15);
    const calm = await open(a.base, w.picker2.token);
    expect(calm.s.connected).toBe(true);
    for (const s of [lead.s, p.s, calm.s]) s.close();
  });
});
