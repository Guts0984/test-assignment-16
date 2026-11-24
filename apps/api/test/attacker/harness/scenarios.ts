// Scenario building blocks over the real network: every call goes through nginx from a per-world
// source IP, so setup traffic never trips the per-IP login limit of other tests.
import { randomUUID } from 'node:crypto';
import { argon2id, hash } from 'argon2';
import { expect } from 'vitest';
import { type StaffRole } from '@ff/shared/domain';
import { client, type Client, until } from './attacker';
import { getStack } from './global';

export const PASSWORD = 'correct-horse-battery';
export const uid = (p = ''): string => `${p}${randomUUID().slice(0, 8)}`.toUpperCase();
export const key = (): string => `k-${randomUUID()}`;

const ipSeed = { n: 10 };
/** A fresh loopback source address (127.0.A.B) for a test or a world. */
export const nextIp = (): string => {
  ipSeed.n += 1;
  return `127.0.${Math.floor(ipSeed.n / 250) + 1}.${(ipSeed.n % 250) + 2}`;
};

export const login = async (api: Client, email: string, password = PASSWORD): Promise<string> => {
  const r = await api.post('/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.text}`);
  return r.body.accessToken as string;
};

export const makeAdmin = async (api: Client): Promise<string> => {
  const email = `admin-${uid()}@adv.local`.toLowerCase();
  await getStack().db.staff.create({
    data: {
      email,
      name: 'Admin',
      passwordHash: await hash(PASSWORD, { type: argon2id }),
      roles: { create: [{ role: 'admin' }] },
    },
  });
  return login(api, email);
};

export type World = Awaited<ReturnType<typeof newWorld>>;

export const newWorld = async (
  o: { cells?: number; minShelfLifeDays?: number; timeZone?: string; country?: string; stub?: boolean } = {},
) => {
  const ip = nextIp();
  const api = client({ sourceIp: ip });
  const admin = await makeAdmin(api);
  const as = api.withAuth(admin);
  const w = await as.post('/api/admin/warehouses', {
    code: uid('W'),
    name: 'Adv warehouse',
    country: o.country ?? 'PL',
    timeZone: o.timeZone ?? 'Europe/Warsaw',
    cutoffLocal: '17:00',
    workingDays: [1, 2, 3, 4, 5],
  });
  expect(w.status, w.text).toBe(201);
  const z = await as.post(`/api/admin/warehouses/${w.body.id}/zones`, { code: 'A', name: 'Zone A' });
  const n = o.cells ?? 6;
  await as.post(`/api/admin/zones/${z.body.id}/cells`, {
    cells: Array.from({ length: n }, (_, i) => ({
      code: `A-${String(i + 1).padStart(3, '0')}`,
      walkOrder: i + 1,
      capacityVolumeCm3: 10_000_000,
      capacityWeightG: 10_000_000,
    })),
  });
  const shopCode = uid('S');
  const shopReq = await as.post('/api/admin/shops', {
    code: shopCode,
    name: 'Adv shop',
    webhookUrl: o.stub === true ? `${getStack().stub}/webhooks/${shopCode}` : 'http://127.0.0.1:9/hook',
    minShelfLifeDays: o.minShelfLifeDays ?? 0,
  });
  expect(shopReq.status, shopReq.text).toBe(201);
  const shop = {
    id: shopReq.body.shop.id as string,
    code: shopCode,
    apiKey: shopReq.body.apiKey as string,
    webhookSecret: shopReq.body.webhookSecret as string,
  };
  if (o.stub === true) {
    const reg = await fetch(`${getStack().stub}/control/shops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-token': getStack().controlToken },
      body: JSON.stringify({ code: shopCode, apiKey: shop.apiKey, webhookSecret: shop.webhookSecret }),
    });
    expect(reg.status).toBe(200);
  }
  const staff = async (role: StaffRole) => {
    const email = `staff-${uid()}@adv.local`.toLowerCase();
    const r = await as.post('/api/admin/staff', {
      email,
      name: `${role} ${uid()}`,
      password: PASSWORD,
      roles: [{ role, warehouseId: w.body.id }],
    });
    expect(r.status, r.text).toBe(201);
    return {
      id: r.body.id as string,
      email,
      token: await login(api, email),
      api: client({ sourceIp: ip, auth: await login(api, email) }),
    };
  };
  const [lead, store, picker1, picker2, packer] = await Promise.all([
    staff('shift_lead'),
    staff('storekeeper'),
    staff('picker'),
    staff('picker'),
    staff('packer'),
  ]);
  return {
    ip,
    api,
    admin,
    as,
    wh: { id: w.body.id as string, code: w.body.code as string },
    shop,
    lead,
    store,
    picker1,
    picker2,
    packer,
    shopApi: client({ sourceIp: ip, auth: shop.apiKey }),
  };
};

export const newSku = async (w: World, tracksExpiry = false) => {
  const code = uid('SKU');
  const r = await w.shopApi.post('/api/shop/v1/skus', {
    code,
    name: `Item ${code}`,
    barcode: uid('BC'),
    weightG: 100,
    lengthMm: 10,
    widthMm: 10,
    heightMm: 10,
    tracksExpiry,
  });
  expect(r.status, r.text).toBe(201);
  return { id: r.body.id as string, code, barcode: r.body.barcode as string };
};

export const stockUp = async (
  w: World,
  sku: { id: string; barcode: string },
  cell: string,
  qty: number,
  batch?: { code: string; expiresOn: string },
) => {
  const rc = await w.store.api.post(`/api/warehouses/${w.wh.id}/receipts`, { shopId: w.shop.id });
  expect(rc.status, rc.text).toBe(201);
  const line = await w.store.api.post(`/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/lines`, {
    barcode: sku.barcode,
    qty,
    ...(batch === undefined ? {} : { batchCode: batch.code, expiresOn: batch.expiresOn }),
    idempotencyKey: key(),
  });
  expect(line.status, line.text).toBe(201);
  await w.store.api.post(`/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/close`);
  const pending = (await w.store.api.get(`/api/warehouses/${w.wh.id}/putaway/pending`)).body.items.find(
    (i: { skuId: string; batchId: string }) => i.skuId === sku.id && i.batchId === line.body.batchId,
  );
  const put = await w.store.api.post(`/api/warehouses/${w.wh.id}/putaway/confirm`, {
    sourceLocationId: pending.sourceLocationId,
    skuId: sku.id,
    batchId: line.body.batchId,
    qty,
    cellCode: cell,
    idempotencyKey: key(),
  });
  expect(put.status, put.text).toBe(201);
  return { batchId: line.body.batchId as string };
};

export const orderPayload = (
  externalNumber: string,
  lines: readonly { sku: string; qty: number }[],
  express = false,
) => ({
  externalNumber,
  deliveryMethod: express ? 'express' : 'standard',
  address: { name: 'Anna Nowak', line1: 'Main 1', city: 'Warsaw', postalCode: '00-001', country: 'PL' },
  lines,
});

export const placeOrder = async (
  w: World,
  lines: readonly { sku: string; qty: number }[],
  express = false,
  number = uid('ORD'),
) => {
  const r = await w.shopApi.post('/api/shop/v1/orders', orderPayload(number, lines, express));
  expect([200, 201], r.text).toContain(r.status);
  return r.body.orderId as string;
};

export const orderStatus = async (id: string): Promise<string> =>
  (await getStack().db.order.findUniqueOrThrow({ where: { id } })).status;
export const statuses = async (ids: readonly string[]) =>
  (await getStack().db.order.findMany({ where: { id: { in: [...ids] } } })).map((o) => o.status);
export const settled = (ids: readonly string[]) =>
  until(async () => (await statuses(ids)).every((s) => s !== 'received'), 60_000, 200);

export const days = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export const startPickingTask = async (w: World, picker = w.picker1) => {
  const wave = await w.lead.api.post(`/api/warehouses/${w.wh.id}/waves`);
  expect(wave.status, wave.text).toBe(201);
  const t = await picker.api.post(`/api/warehouses/${w.wh.id}/tasks/next`);
  expect(t.status, t.text).toBe(200);
  return t.body;
};

export const scan = (w: World, taskId: string, body: Record<string, unknown>, picker = w.picker1) =>
  picker.api.post(`/api/warehouses/${w.wh.id}/tasks/${taskId}/scan`, { idempotencyKey: key(), ...body });
