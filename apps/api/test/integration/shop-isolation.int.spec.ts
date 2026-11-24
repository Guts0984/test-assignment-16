// Shops, keys, SKUs and orders: isolation between shops, idempotent import, key revocation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { http, startTestApp, type TestApp } from '../setup/app';
import { makeAdmin, makeShop, makeSku, makeStaff, makeWarehouse, orderBody, uid } from '../setup/fixtures';

let t: TestApp;
let api: ReturnType<typeof http>;
let admin: string;
beforeAll(async () => {
  t = await startTestApp({ RATE_LIMIT_ENABLED: 'false' });
  api = http(t.base);
  admin = await makeAdmin(t.db, api);
  await makeWarehouse(api, admin, { cells: 1 });
});
afterAll(async () => t.close());

describe('SKUs', () => {
  it('barcode is unique per shop, not globally; codes too', async () => {
    const a = await makeShop(api, admin);
    const b = await makeShop(api, admin);
    const sku = await makeSku(api, a.apiKey);
    const body = {
      code: uid('X'),
      name: 'n',
      barcode: sku.barcode,
      weightG: 1,
      lengthMm: 1,
      widthMm: 1,
      heightMm: 1,
      tracksExpiry: false,
    };
    expect((await api.post('/api/shop/v1/skus', body, { token: a.apiKey })).body.error.code).toBe(
      'DUPLICATE_BARCODE',
    );
    expect((await api.post('/api/shop/v1/skus', body, { token: b.apiKey })).status).toBe(201);
    const dupCode = { ...body, code: sku.code, barcode: uid('Y') };
    expect((await api.post('/api/shop/v1/skus', dupCode, { token: a.apiKey })).body.error.code).toBe(
      'DUPLICATE_CODE',
    );
  });

  it('parallel creation with the same barcode creates one SKU', async () => {
    const a = await makeShop(api, admin);
    const body = {
      code: uid('P'),
      name: 'n',
      barcode: uid('B'),
      weightG: 1,
      lengthMm: 1,
      widthMm: 1,
      heightMm: 1,
      tracksExpiry: false,
    };
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api.post('/api/shop/v1/skus', { ...body, code: `${body.code}-${i}` }, { token: a.apiKey }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(7);
  });

  it('shop B cannot read shop A SKU (404, no existence leak)', async () => {
    const a = await makeShop(api, admin);
    const b = await makeShop(api, admin);
    const sku = await makeSku(api, a.apiKey);
    expect((await api.get(`/api/shop/v1/skus/${sku.id}`, { token: b.apiKey })).status).toBe(404);
    expect((await api.get(`/api/shop/v1/skus/${sku.id}`, { token: a.apiKey })).status).toBe(200);
  });
});

describe('order import', () => {
  it('10 parallel identical imports create one order; all return the same id', async () => {
    const s = await makeShop(api, admin);
    const sku = await makeSku(api, s.apiKey);
    const body = orderBody(uid('ORD'), [{ sku: sku.code, qty: 2 }]);
    const res = await Promise.all(
      Array.from({ length: 10 }, () => api.post('/api/shop/v1/orders', body, { token: s.apiKey })),
    );
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(res.map((r) => r.body.orderId)).size).toBe(1);
    expect(await t.db.order.count({ where: { shopId: s.id, externalNumber: body.externalNumber } })).toBe(1);
    expect(
      await t.db.scheduledAction.count({ where: { kind: 'reserve_order', key: res[0]?.body.orderId } }),
    ).toBe(1);
    expect(await t.db.webhookEvent.count({ where: { stream: `order:${res[0]?.body.orderId}` } })).toBe(1);
  });

  it('same number with different content is ORDER_CONFLICT', async () => {
    const s = await makeShop(api, admin);
    const sku = await makeSku(api, s.apiKey);
    const n = uid('ORD');
    expect(
      (await api.post('/api/shop/v1/orders', orderBody(n, [{ sku: sku.code, qty: 1 }]), { token: s.apiKey }))
        .status,
    ).toBe(201);
    const r = await api.post('/api/shop/v1/orders', orderBody(n, [{ sku: sku.code, qty: 2 }]), {
      token: s.apiKey,
    });
    expect([r.status, r.body.error.code]).toEqual([409, 'ORDER_CONFLICT']);
  });

  it('another shop may reuse the number; a forged shopId is rejected; a foreign SKU is unknown', async () => {
    const a = await makeShop(api, admin);
    const b = await makeShop(api, admin);
    const skuA = await makeSku(api, a.apiKey);
    const skuB = await makeSku(api, b.apiKey);
    const n = uid('ORD');
    expect(
      (await api.post('/api/shop/v1/orders', orderBody(n, [{ sku: skuA.code, qty: 1 }]), { token: a.apiKey }))
        .status,
    ).toBe(201);
    expect(
      (await api.post('/api/shop/v1/orders', orderBody(n, [{ sku: skuB.code, qty: 1 }]), { token: b.apiKey }))
        .status,
    ).toBe(201);
    const forged = await api.post(
      '/api/shop/v1/orders',
      { ...orderBody(uid('O'), [{ sku: skuB.code, qty: 1 }]), shopId: a.id },
      { token: b.apiKey },
    );
    expect(forged.status).toBe(400);
    const foreign = await api.post('/api/shop/v1/orders', orderBody(uid('O'), [{ sku: skuA.code, qty: 1 }]), {
      token: b.apiKey,
    });
    expect([foreign.status, foreign.body.error.code]).toEqual([422, 'UNKNOWN_SKU']);
  });

  it('shop B cannot read shop A order, by id or by search', async () => {
    const a = await makeShop(api, admin);
    const b = await makeShop(api, admin);
    const sku = await makeSku(api, a.apiKey);
    const n = uid('SECRET');
    const id = (
      await api.post('/api/shop/v1/orders', orderBody(n, [{ sku: sku.code, qty: 1 }]), { token: a.apiKey })
    ).body.orderId;
    expect((await api.get(`/api/shop/v1/orders/${id}`, { token: b.apiKey })).status).toBe(404);
    expect((await api.get(`/api/shop/v1/orders?q=${n}`, { token: b.apiKey })).body.items).toEqual([]);
    expect((await api.get(`/api/shop/v1/orders?shopId=${a.id}`, { token: b.apiKey })).status).toBe(403);
    const mine = await api.get(`/api/shop/v1/orders/${id}`, { token: a.apiKey });
    expect([mine.status, mine.body.history[0].to]).toEqual([200, 'received']);
  });

  it('search treats LIKE wildcards literally and survives SQL injection strings', async () => {
    const a = await makeShop(api, admin);
    const sku = await makeSku(api, a.apiKey);
    await api.post('/api/shop/v1/orders', orderBody(uid('W'), [{ sku: sku.code, qty: 1 }]), {
      token: a.apiKey,
    });
    expect((await api.get('/api/shop/v1/orders?q=%25', { token: a.apiKey })).body.items).toEqual([]);
    expect((await api.get('/api/shop/v1/orders?q=_', { token: a.apiKey })).body.items).toEqual([]);
    const inj = await api.get(`/api/shop/v1/orders?q=${encodeURIComponent("' OR 1=1 --")}`, {
      token: a.apiKey,
    });
    expect([inj.status, inj.body.items]).toEqual([200, []]);
    expect((await api.get('/api/shop/v1/orders?cursor=not-a-cursor', { token: a.apiKey })).status).toBe(400);
    expect((await api.get('/api/shop/v1/orders?limit=-1', { token: a.apiKey })).status).toBe(400);
  });

  it('staff only see orders of their warehouses', async () => {
    const w1 = await makeWarehouse(api, admin, { cells: 0 });
    const w2 = await makeWarehouse(api, admin, { cells: 0 });
    const lead = await makeStaff(api, admin, [{ role: 'shift_lead', warehouseId: w1.id }]);
    expect((await api.get(`/api/orders?warehouseId=${w2.id}`, { token: lead.token })).status).toBe(403);
    expect((await api.get(`/api/orders?warehouseId=${w1.id}`, { token: lead.token })).status).toBe(200);
  });

  it('a revoked API key stops working at once', async () => {
    const s = await makeShop(api, admin);
    const keys = await api.get(`/api/admin/shops/${s.id}/api-keys`, { token: admin });
    expect((await api.get('/api/shop/v1/skus', { token: s.apiKey })).status).toBe(200);
    await api.post(`/api/admin/shops/${s.id}/api-keys/${keys.body.items[0].id}/revoke`, undefined, {
      token: admin,
    });
    expect((await api.get('/api/shop/v1/skus', { token: s.apiKey })).status).toBe(401);
    const truncated = s.apiKey.slice(0, -1);
    expect((await api.get('/api/shop/v1/skus', { token: truncated })).status).toBe(401);
  });

  it('stock view shows every warehouse with zero stock for a new SKU', async () => {
    const s = await makeShop(api, admin);
    const sku = await makeSku(api, s.apiKey);
    const r = await api.get(`/api/shop/v1/stock?q=${sku.code}`, { token: s.apiKey });
    expect(r.status).toBe(200);
    expect(r.body.items[0].warehouses.length).toBeGreaterThan(0);
    expect(r.body.items[0].warehouses.every((w: { available: number }) => w.available === 0)).toBe(true);
  });
});

describe('empty PATCH bodies', () => {
  it('an empty patch on an existing resource is 200, on a missing one 404', async () => {
    const s = await makeShop(api, admin);
    const w = await makeWarehouse(api, admin, { cells: 0 });
    const sku = await makeSku(api, s.apiKey);
    expect((await api.patch(`/api/admin/shops/${s.id}`, {}, { token: admin })).status).toBe(200);
    expect((await api.patch(`/api/admin/warehouses/${w.id}`, {}, { token: admin })).status).toBe(200);
    expect((await api.patch(`/api/shop/v1/skus/${sku.id}`, {}, { token: s.apiKey })).status).toBe(200);
    expect(
      (await api.patch('/api/admin/shops/00000000-0000-4000-8000-000000000000', {}, { token: admin })).status,
    ).toBe(404);
  });
});
