// Test data for the browser journeys, created through the real api (nginx), never by touching the db.
import { randomUUID } from 'node:crypto';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
export const STUB = `http://localhost:${process.env.SHOP_STUB_HOST_PORT ?? '24000'}`;
export const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123';
const CONTROL = process.env.TEST_CONTROL_TOKEN ?? '';
export const uid = (p = ''): string => `${p}${randomUUID().slice(0, 8)}`.toUpperCase();

export const call = async (
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
};

export const login = async (email: string, password = PASSWORD): Promise<string> => {
  const r = await call('POST', '/api/auth/login', undefined, { email, password });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken as string;
};

export const stubControl = (path: string, body: unknown) =>
  fetch(`${STUB}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-token': CONTROL },
    body: JSON.stringify(body),
  });

export const clock = {
  set: (iso: string) => (
    dropAdmin(),
    fetch(`${BASE}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-token': CONTROL },
      body: JSON.stringify({ setTo: iso }),
    })
  ),
  advance: (ms: number) =>
    fetch(`${BASE}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-token': CONTROL },
      body: JSON.stringify({ advanceMs: ms }),
    }),
  reset: () => (
    dropAdmin(),
    fetch(`${BASE}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-token': CONTROL },
      body: JSON.stringify({ reset: true }),
    })
  ),
};

export const poll = async <T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 60_000,
  every = 300,
): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, every));
  }
};

export type World = Awaited<ReturnType<typeof newWorld>>;

/** A fresh warehouse, shop (wired to the stub), staff of every role and a shop cabinet user. */
const adminCache: { token: string | null; at: number } = { token: null, at: 0 };
/** Tokens are bound to the (shared) clock, so every clock change drops the cached admin token. */
const dropAdmin = (): void => {
  adminCache.token = null;
  adminCache.at = 0;
};
const adminToken = async (): Promise<string> => {
  if (adminCache.token === null || Date.now() - adminCache.at > 5 * 60_000)
    adminCache.token = await login('admin@demo.local');
  adminCache.at = adminCache.token === null ? 0 : adminCache.at || Date.now();
  return adminCache.token;
};

export const newWorld = async (o: { timeZone?: string; cells?: number } = {}) => {
  const admin = await adminToken();
  const wh = (
    await call('POST', '/api/admin/warehouses', admin, {
      code: uid('E'),
      name: 'E2E warehouse',
      country: 'PL',
      timeZone: o.timeZone ?? 'Europe/Warsaw',
      cutoffLocal: '17:00',
      workingDays: [1, 2, 3, 4, 5],
    })
  ).body;
  const zone = (
    await call('POST', `/api/admin/warehouses/${wh.id}/zones`, admin, { code: 'A', name: 'Zone A' })
  ).body;
  await call('POST', `/api/admin/zones/${zone.id}/cells`, admin, {
    cells: Array.from({ length: o.cells ?? 6 }, (_, i) => ({
      code: `A-${String(i + 1).padStart(3, '0')}`,
      walkOrder: i + 1,
      capacityVolumeCm3: 10_000_000,
      capacityWeightG: 10_000_000,
    })),
  });
  const code = uid('SHOP');
  const shop = (
    await call('POST', '/api/admin/shops', admin, {
      code,
      name: `E2E shop ${code}`,
      webhookUrl: `http://shop-stub:4000/webhooks/${code}`,
      minShelfLifeDays: 0,
    })
  ).body;
  await stubControl('/control/shops', { code, apiKey: shop.apiKey, webhookSecret: shop.webhookSecret });
  const cabinetEmail = `cabinet-${uid()}@e2e.local`.toLowerCase();
  await call('POST', `/api/admin/shops/${shop.shop.id}/users`, admin, {
    email: cabinetEmail,
    name: 'Cabinet',
    password: PASSWORD,
  });
  const staff = async (role: string) => {
    const email = `${role}-${uid()}@e2e.local`.toLowerCase();
    const r = await call('POST', '/api/admin/staff', admin, {
      email,
      name: `${role} ${uid()}`,
      password: PASSWORD,
      roles: [{ role, warehouseId: wh.id }],
    });
    return { id: r.body.id as string, email, token: await login(email) };
  };
  const [lead, store, picker, packer] = await Promise.all([
    staff('shift_lead'),
    staff('storekeeper'),
    staff('picker'),
    staff('packer'),
  ]);
  return {
    admin,
    wh: { id: wh.id as string, code: wh.code as string },
    shop: { id: shop.shop.id as string, code, apiKey: shop.apiKey as string },
    cabinetEmail,
    lead,
    store,
    picker,
    packer,
  };
};

export const newSku = async (w: World) => {
  const code = uid('SKU');
  const r = await call('POST', '/api/shop/v1/skus', w.shop.apiKey, {
    code,
    name: `E2E item ${code}`,
    barcode: uid('BC'),
    weightG: 100,
    lengthMm: 10,
    widthMm: 10,
    heightMm: 10,
    tracksExpiry: false,
  });
  return { id: r.body.id as string, code, barcode: r.body.barcode as string };
};

export const stockUp = async (w: World, sku: { id: string; barcode: string }, cell: string, qty: number) => {
  const rc = await call('POST', `/api/warehouses/${w.wh.id}/receipts`, w.store.token, { shopId: w.shop.id });
  const line = await call('POST', `/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/lines`, w.store.token, {
    barcode: sku.barcode,
    qty,
    idempotencyKey: randomUUID().replace(/-/g, ''),
  });
  await call('POST', `/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/close`, w.store.token);
  const pending = (
    await call('GET', `/api/warehouses/${w.wh.id}/putaway/pending`, w.store.token)
  ).body.items.find(
    (i: { skuId: string; batchId: string }) => i.skuId === sku.id && i.batchId === line.body.batchId,
  );
  await call('POST', `/api/warehouses/${w.wh.id}/putaway/confirm`, w.store.token, {
    sourceLocationId: pending.sourceLocationId,
    skuId: sku.id,
    batchId: line.body.batchId,
    qty,
    cellCode: cell,
    idempotencyKey: randomUUID().replace(/-/g, ''),
  });
};

export const sendOrder = async (
  w: World,
  lines: { sku: string; qty: number }[],
  externalNumber = uid('E2E'),
) => {
  const r = await fetch(`${STUB}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shop: w.shop.code, count: 1, externalNumber, lines }),
  });
  const j = (await r.json()) as {
    results: { externalNumber: string; responses: { status: number; orderId: string | null }[] }[];
  };
  const orderId = j.results[0]?.responses.find((x) => x.orderId !== null)?.orderId;
  if (orderId === null || orderId === undefined)
    throw new Error(`stub could not send the order: ${JSON.stringify(j)}`);
  return { orderId, externalNumber };
};

export const orderState = async (w: World, orderId: string) =>
  (await call('GET', `/api/shop/v1/orders/${orderId}`, w.shop.apiKey)).body;
export const stubHooks = async (code: string) =>
  (
    (await (await fetch(`${STUB}/api/webhooks?shop=${code}`)).json()) as {
      items: { outcome: string; type: string; stream: string; version: number; data: any }[];
    }
  ).items;
