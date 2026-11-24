// Fixtures built through the public API (plus one bootstrap admin row), unique per call so tests
// run in parallel without interfering.
import { randomUUID } from 'node:crypto';
import { hash, argon2id } from 'argon2';
import { type Db } from '@ff/db/client';
import { type StaffRole } from '@ff/shared/domain';
import { type http } from './app';

export const uid = (p = ''): string => `${p}${randomUUID().slice(0, 8)}`.toUpperCase();
export const PASSWORD = 'correct-horse-battery';

type Api = ReturnType<typeof http>;

export const login = async (api: Api, email: string, password = PASSWORD): Promise<string> => {
  const r = await api.post<{ accessToken: string }>('/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
};

export const makeAdmin = async (db: Db, api: Api): Promise<string> => {
  const email = `admin-${uid()}@test.local`.toLowerCase();
  await db.staff.create({
    data: {
      email,
      name: 'Admin',
      passwordHash: await hash(PASSWORD, { type: argon2id }),
      roles: { create: [{ role: 'admin' }] },
    },
  });
  return login(api, email);
};

export const makeWarehouse = async (
  api: Api,
  admin: string,
  o: Partial<{ timeZone: string; country: string; cells: number; lat: number; lon: number }> = {},
) => {
  const w = await api.post(
    '/api/admin/warehouses',
    {
      code: uid('W'),
      name: 'Test warehouse',
      country: o.country ?? 'PL',
      timeZone: o.timeZone ?? 'Europe/Warsaw',
      cutoffLocal: '17:00',
      workingDays: [1, 2, 3, 4, 5],
      ...(o.lat === undefined ? {} : { lat: o.lat, lon: o.lon }),
    },
    { token: admin },
  );
  if (w.status !== 201) throw new Error(`warehouse: ${w.status} ${JSON.stringify(w.body)}`);
  const z = await api.post(
    `/api/admin/warehouses/${w.body.id}/zones`,
    { code: 'A', name: 'Zone A' },
    { token: admin },
  );
  const n = o.cells ?? 3;
  if (n > 0) {
    await api.post(
      `/api/admin/zones/${z.body.id}/cells`,
      {
        cells: Array.from({ length: n }, (_, i) => ({
          code: `A-${String(i + 1).padStart(3, '0')}`,
          walkOrder: i + 1,
          capacityVolumeCm3: 10_000_000,
          capacityWeightG: 10_000_000,
        })),
      },
      { token: admin },
    );
  }
  return { id: w.body.id as string, code: w.body.code as string, zoneId: z.body.id as string };
};

export const makeShop = async (
  api: Api,
  admin: string,
  o: Partial<{ minShelfLifeDays: number; webhookUrl: string }> = {},
) => {
  const r = await api.post(
    '/api/admin/shops',
    {
      code: uid('S'),
      name: 'Test shop',
      webhookUrl: o.webhookUrl ?? 'http://127.0.0.1:9/hooks',
      minShelfLifeDays: o.minShelfLifeDays ?? 0,
    },
    { token: admin },
  );
  if (r.status !== 201) throw new Error(`shop: ${r.status} ${JSON.stringify(r.body)}`);
  return {
    id: r.body.shop.id as string,
    apiKey: r.body.apiKey as string,
    webhookSecret: r.body.webhookSecret as string,
  };
};

export const makeStaff = async (
  api: Api,
  admin: string,
  roles: readonly { role: StaffRole; warehouseId: string | null }[],
) => {
  const email = `staff-${uid()}@test.local`.toLowerCase();
  const r = await api.post(
    '/api/admin/staff',
    { email, name: 'Worker', password: PASSWORD, roles },
    { token: admin },
  );
  if (r.status !== 201) throw new Error(`staff: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id as string, email, token: await login(api, email) };
};

export const makeSku = async (
  api: Api,
  apiKey: string,
  o: Partial<{ tracksExpiry: boolean; code: string }> = {},
) => {
  const code = o.code ?? uid('SKU');
  const r = await api.post(
    '/api/shop/v1/skus',
    {
      code,
      name: `Item ${code}`,
      barcode: uid('BC'),
      weightG: 100,
      lengthMm: 10,
      widthMm: 10,
      heightMm: 10,
      tracksExpiry: o.tracksExpiry ?? false,
    },
    { token: apiKey },
  );
  if (r.status !== 201) throw new Error(`sku: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id as string, code, barcode: r.body.barcode as string };
};

export const orderBody = (
  externalNumber: string,
  lines: readonly { sku: string; qty: number }[],
  express = false,
) => ({
  externalNumber,
  deliveryMethod: express ? 'express' : 'standard',
  address: { name: 'Anna Nowak', line1: 'Main 1', city: 'Warsaw', postalCode: '00-001', country: 'PL' },
  lines,
});
