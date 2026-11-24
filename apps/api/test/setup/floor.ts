// A small warehouse world built through the public API, plus an in-process drain of due background
// actions (the worker's handlers), so floor flows run end to end inside one test.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { isBalanced, ledgerReport } from '@ff/db/ledger';
import { nullEmitter } from '@ff/core/realtime';
import { floorHandlers } from '@ff/core/jobs/handlers';
import { drainDue, type JobDeps } from '@ff/core/jobs/run-action';
import { FloorService } from '../../src/modules/floor/floor.service';
import { http, type TestApp } from './app';
import { makeAdmin, makeShop, makeSku, makeStaff, makeWarehouse, orderBody, uid } from './fixtures';

export const key = (): string => `k-${randomUUID()}`;

export const jobDeps = (t: TestApp): JobDeps => {
  const { deps } = t.app.get(FloorService);
  const base = {
    ...deps,
    emitter: nullEmitter,
    queues: null,
    jobs: { leaseMs: 30_000, maxAttempts: 5, backoffBaseMs: 10, backoffMaxMs: 100 },
  };
  return { ...base, handlers: floorHandlers(base) };
};

export const drain = (t: TestApp): Promise<number> =>
  drainDue(jobDeps(t), 'test-worker', ['reserve_order', 'rereserve', 'wave_check', 'partial_reserve_expiry']);

export const expectBalanced = async (t: TestApp): Promise<void> => {
  const r = await ledgerReport(t.db);
  expect({
    ledger: r.ledgerMismatches,
    reservations: r.reservationMismatches,
    lines: r.lineMismatches,
    negative: r.negativeBalances,
  }).toEqual({ ledger: 0, reservations: 0, lines: 0, negative: 0 });
  expect(isBalanced(r)).toBe(true);
};

export const world = async (
  t: TestApp,
  o: { cells?: number; minShelfLifeDays?: number; country?: string; timeZone?: string } = {},
) => {
  const api = http(t.base);
  const admin = await makeAdmin(t.db, api);
  const wh = await makeWarehouse(api, admin, {
    cells: o.cells ?? 6,
    ...(o.country ? { country: o.country } : {}),
    ...(o.timeZone ? { timeZone: o.timeZone } : {}),
  });
  const shop = await makeShop(api, admin, { minShelfLifeDays: o.minShelfLifeDays ?? 0 });
  const at = (role: 'shift_lead' | 'storekeeper' | 'picker' | 'packer') =>
    makeStaff(api, admin, [{ role, warehouseId: wh.id }]);
  const [lead, store, picker1, picker2, packer] = await Promise.all([
    at('shift_lead'),
    at('storekeeper'),
    at('picker'),
    at('picker'),
    at('packer'),
  ]);
  const cells = (
    await api.get(`/api/warehouses/${wh.id}/cells?limit=500`, { token: lead.token })
  ).body.items.filter((c: { kind: string }) => c.kind === 'storage') as { id: string; code: string }[];
  const w = { api, admin, wh, shop, lead, store, picker1, picker2, packer, cells };
  return w;
};
export type World = Awaited<ReturnType<typeof world>>;

/** Receives `qty` units into the dock and puts them away into `cellCode`. */
export const stockUp = async (
  w: World,
  sku: { id: string; barcode: string },
  cellCode: string,
  qty: number,
  batch?: { code: string; expiresOn: string },
) => {
  const rc = await w.api.post(
    `/api/warehouses/${w.wh.id}/receipts`,
    { shopId: w.shop.id },
    { token: w.store.token },
  );
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  const line = await w.api.post(
    `/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/lines`,
    {
      barcode: sku.barcode,
      qty,
      ...(batch === undefined ? {} : { batchCode: batch.code, expiresOn: batch.expiresOn }),
      idempotencyKey: key(),
    },
    { token: w.store.token },
  );
  expect(line.status, JSON.stringify(line.body)).toBe(201);
  await w.api.post(`/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/close`, undefined, {
    token: w.store.token,
  });
  const pending = (
    await w.api.get(`/api/warehouses/${w.wh.id}/putaway/pending`, { token: w.store.token })
  ).body.items.find(
    (i: { skuId: string; batchId: string }) => i.skuId === sku.id && i.batchId === line.body.batchId,
  );
  const put = await w.api.post(
    `/api/warehouses/${w.wh.id}/putaway/confirm`,
    {
      sourceLocationId: pending.sourceLocationId,
      skuId: sku.id,
      batchId: line.body.batchId,
      qty,
      cellCode,
      idempotencyKey: key(),
    },
    { token: w.store.token },
  );
  expect(put.status, JSON.stringify(put.body)).toBe(201);
  return { batchId: line.body.batchId as string };
};

export const newSku = (w: World, tracksExpiry = false) => makeSku(w.api, w.shop.apiKey, { tracksExpiry });

export const placeOrder = async (
  w: World,
  lines: readonly { sku: string; qty: number }[],
  express = false,
  number = uid('ORD'),
) => {
  const r = await w.api.post('/api/shop/v1/orders', orderBody(number, lines, express), {
    token: w.shop.apiKey,
  });
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  return r.body.orderId as string;
};

export const orderStatus = async (t: TestApp, id: string): Promise<string> =>
  (await t.db.order.findUniqueOrThrow({ where: { id } })).status;
