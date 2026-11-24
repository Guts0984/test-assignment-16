// Stock rules in-process: concurrent reserve, FEFO with minimum shelf life, fair re-reserve,
// shortage relocation, stock counts with approval, cancel in every phase, transfers, cutoff.
import { newEffects } from '@ff/core/effects';
import { reserveOrder } from '@ff/core/floor/reserve';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../setup/app';
import { makeStaff, makeWarehouse } from '../setup/fixtures';
import {
  drain,
  expectBalanced,
  jobDeps,
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
  t = await startTestApp({ RATE_LIMIT_ENABLED: 'false', PARTIAL_RESERVE_TTL_MIN: '60' });
});
afterAll(async () => t.close());

const days = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const reservedOf = async (orderId: string) =>
  (await t.db.orderLine.findMany({ where: { orderId } })).reduce((s, l) => s + l.reservedQty, 0);
const startPicking = async (w: World) => {
  await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
  return (await w.api.post(`/api/warehouses/${w.wh.id}/tasks/next`, undefined, { token: w.picker1.token }))
    .body;
};

describe('reserve', () => {
  it('60 orders racing for 20 units: exactly 20 reserved, 40 awaiting stock, nothing negative', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 12);
    await stockUp(w, sku, 'A-002', 8);
    const ids = await Promise.all(
      Array.from({ length: 60 }, () => placeOrder(w, [{ sku: sku.code, qty: 1 }])),
    );
    const d = jobDeps(t);
    await Promise.all(ids.map((id) => reserveOrder(d, newEffects(), id)));
    const statuses = await Promise.all(ids.map((id) => orderStatus(t, id)));
    expect(statuses.filter((s) => s === 'reserved')).toHaveLength(20);
    expect(statuses.filter((s) => s === 'awaiting_stock')).toHaveLength(40);
    await expectBalanced(t);
  });

  it('acceptance #4: batches at 10/40/90 days with shop minimum 30 -> the 40-day batch, never the 10-day one', async () => {
    const w = await world(t, { minShelfLifeDays: 30 });
    const sku = await newSku(w, true);
    const b10 = await stockUp(w, sku, 'A-001', 5, { code: 'D10', expiresOn: days(10) });
    const b40 = await stockUp(w, sku, 'A-002', 5, { code: 'D40', expiresOn: days(40) });
    const b90 = await stockUp(w, sku, 'A-003', 5, { code: 'D90', expiresOn: days(90) });
    const first = await placeOrder(w, [{ sku: sku.code, qty: 3 }]);
    await drain(t);
    const r1 = await t.db.orderReservation.findMany({ where: { orderId: first } });
    expect(r1.map((r) => [r.batchId, r.qty])).toEqual([[b40.batchId, 3]]);
    const second = await placeOrder(w, [{ sku: sku.code, qty: 4 }]);
    await drain(t);
    const r2 = await t.db.orderReservation.findMany({ where: { orderId: second }, orderBy: { qty: 'asc' } });
    expect(new Set(r2.map((r) => r.batchId))).toEqual(new Set([b40.batchId, b90.batchId]));
    expect(await t.db.orderReservation.count({ where: { batchId: b10.batchId } })).toBe(0);
    const third = await placeOrder(w, [{ sku: sku.code, qty: 5 }]);
    await drain(t);
    expect(await orderStatus(t, third)).toBe('awaiting_stock');
    expect(await t.db.orderReservation.count({ where: { batchId: b10.batchId } })).toBe(0);
    await expectBalanced(t);
  });

  it('acceptance #5 (small): re-reserve after putaway gives stock to express first, then the earliest', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    const order = async (express: boolean) => placeOrder(w, [{ sku: sku.code, qty: 1 }], express);
    const s1 = await order(false);
    const e1 = await order(true);
    const s2 = await order(false);
    const e2 = await order(true);
    const s3 = await order(false);
    await drain(t);
    for (const id of [s1, e1, s2, e2, s3]) expect(await orderStatus(t, id)).toBe('awaiting_stock');
    await stockUp(w, sku, 'A-001', 3);
    await drain(t);
    const st = Object.fromEntries(
      await Promise.all(
        Object.entries({ s1, e1, s2, e2, s3 }).map(async ([k, id]) => [k, await orderStatus(t, id)]),
      ),
    );
    expect(st).toEqual({
      e1: 'reserved',
      e2: 'reserved',
      s1: 'reserved',
      s2: 'awaiting_stock',
      s3: 'awaiting_stock',
    });
    await stockUp(w, sku, 'A-002', 10);
    await drain(t);
    expect(await orderStatus(t, s3)).toBe('reserved');
    for (const id of [s1, e1, s2, e2, s3]) expect(await reservedOf(id)).toBe(1);
    await expectBalanced(t);
  });

  it('a partial reserve expires, is released, and the order then waits for all of it', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 2);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 5 }]);
    await drain(t);
    expect([await orderStatus(t, id), await reservedOf(id)]).toEqual(['awaiting_stock', 2]);
    await t.db
      .$executeRaw`UPDATE scheduled_actions SET due_at = now() - interval '1 second' WHERE kind = 'partial_reserve_expiry' AND key = ${id}`;
    await t.db
      .$executeRaw`UPDATE orders SET partial_reserve_expires_at = now() - interval '1 second' WHERE id = ${id}::uuid`;
    await drain(t);
    expect(await reservedOf(id)).toBe(0);
    await stockUp(w, sku, 'A-002', 2);
    await drain(t);
    expect(await reservedOf(id)).toBe(0);
    await stockUp(w, sku, 'A-003', 1);
    await drain(t);
    expect([await orderStatus(t, id), await reservedOf(id)]).toEqual(['reserved', 5]);
    await expectBalanced(t);
  });
});

describe('shortage', () => {
  it('blocks the cell, moves the reserve to another cell in the same transaction and picking goes on', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 3);
    await stockUp(w, sku, 'A-003', 5);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 2 }]);
    await drain(t);
    const task = await startPicking(w);
    const line = task.lines[0];
    const cellA = line.cellCode;
    const r = await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/shortage`,
      { lineId: line.lineId, foundQty: 0, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const open = r.body.lines.filter((l: { status: string }) => l.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0].cellCode).not.toBe(cellA);
    expect(
      (await t.db.location.findFirstOrThrow({ where: { warehouseId: w.wh.id, code: cellA } })).blockedReason,
    ).toBe('shortage');
    expect(
      await t.db.stockCount.count({ where: { warehouseId: w.wh.id, status: 'open', origin: 'shortage' } }),
    ).toBe(1);
    const other = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await drain(t);
    const rs = await t.db.orderReservation.findMany({ where: { orderId: other } });
    const blockedId = (await t.db.location.findFirstOrThrow({ where: { warehouseId: w.wh.id, code: cellA } }))
      .id;
    expect(rs.every((x) => x.locationId !== blockedId)).toBe(true);
    const scan = await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      {
        lineId: open[0].lineId,
        cellCode: open[0].cellCode,
        barcode: sku.barcode,
        qty: 2,
        idempotencyKey: key(),
      },
      { token: w.picker1.token },
    );
    expect(scan.body.orderStatus).toBe('picked');
    expect(await orderStatus(t, id)).toBe('picked');
    await expectBalanced(t);
  });

  it('with no stock elsewhere the order goes back to awaiting_stock, picked units stay in packing', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 3);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 3 }]);
    await drain(t);
    const task = await startPicking(w);
    const line = task.lines[0];
    const r = await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/shortage`,
      { lineId: line.lineId, foundQty: 1, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await orderStatus(t, id)).toBe('awaiting_stock');
    expect((await t.db.orderLine.findFirstOrThrow({ where: { orderId: id } })).pickedQty).toBe(1);
    expect((await t.db.pickTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('cancelled');
    await stockUp(w, sku, 'A-002', 5);
    await drain(t);
    expect(await orderStatus(t, id)).toBe('reserved');
    expect(await reservedOf(id)).toBe(2);
    await expectBalanced(t);
  });
});

describe('stock counts', () => {
  it('acceptance #9: a count on a cell being picked; discrepancy 7 waits for the shift lead', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 20);
    await placeOrder(w, [{ sku: sku.code, qty: 2 }]);
    await drain(t);
    const task = await startPicking(w);
    const line = task.lines[0];
    await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { lineId: line.lineId, cellCode: line.cellCode, barcode: sku.barcode, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    const cell = await t.db.location.findFirstOrThrow({
      where: { warehouseId: w.wh.id, code: line.cellCode },
    });
    const c = await w.api.post(
      `/api/warehouses/${w.wh.id}/counts`,
      { cellIds: [cell.id], assigneeId: w.store.id },
      { token: w.lead.token },
    );
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const late = await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { lineId: line.lineId, cellCode: line.cellCode, barcode: sku.barcode, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    expect(late.status).not.toBe(200);
    const batch = await t.db.batch.findFirstOrThrow({ where: { skuId: sku.id } });
    const submit = await w.api.post(
      `/api/warehouses/${w.wh.id}/counts/${c.body.ids[0]}/submit`,
      {
        lines: [{ skuId: sku.id, batchId: batch.id, countedQty: 12, reason: 'damaged boxes' }],
        idempotencyKey: key(),
      },
      { token: w.store.token },
    );
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    expect(submit.body.lines[0]).toMatchObject({
      systemQty: 19,
      countedQty: 12,
      delta: -7,
      requiresApproval: true,
    });
    expect(submit.body.status).toBe('pending_approval');
    expect(
      (
        await w.api.post(
          `/api/warehouses/${w.wh.id}/counts/${c.body.ids[0]}/approve`,
          { approve: true },
          { token: w.store.token },
        )
      ).status,
    ).toBe(403);
    const ok = await w.api.post(
      `/api/warehouses/${w.wh.id}/counts/${c.body.ids[0]}/approve`,
      { approve: true },
      { token: w.lead.token },
    );
    expect(ok.body.status).toBe('closed');
    const adj = await t.db.adjustment.findFirstOrThrow({ where: { countId: c.body.ids[0] } });
    expect([adj.delta, adj.reason, adj.authorId, adj.approvedBy]).toEqual([
      -7,
      'damaged boxes',
      w.store.id,
      w.lead.id,
    ]);
    expect((await t.db.location.findUniqueOrThrow({ where: { id: cell.id } })).blockedReason).toBeNull();
    await expectBalanced(t);
  });

  it('small discrepancies close at once; a reason is required; one open count per cell', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 100);
    const cell = await t.db.location.findFirstOrThrow({ where: { warehouseId: w.wh.id, code: 'A-001' } });
    const c = await w.api.post(
      `/api/warehouses/${w.wh.id}/counts`,
      { cellIds: [cell.id], assigneeId: w.store.id },
      { token: w.lead.token },
    );
    expect(
      (await w.api.post(`/api/warehouses/${w.wh.id}/counts`, { cellIds: [cell.id] }, { token: w.lead.token }))
        .body.error.code,
    ).toBe('COUNT_ALREADY_OPEN');
    const batch = await t.db.batch.findFirstOrThrow({ where: { skuId: sku.id } });
    const noReason = await w.api.post(
      `/api/warehouses/${w.wh.id}/counts/${c.body.ids[0]}/submit`,
      { lines: [{ skuId: sku.id, batchId: batch.id, countedQty: 95 }], idempotencyKey: key() },
      { token: w.store.token },
    );
    expect(noReason.status).toBe(400);
    const ok = await w.api.post(
      `/api/warehouses/${w.wh.id}/counts/${c.body.ids[0]}/submit`,
      {
        lines: [{ skuId: sku.id, batchId: batch.id, countedQty: 95, reason: 'miscount' }],
        idempotencyKey: key(),
      },
      { token: w.store.token },
    );
    expect([ok.body.status, ok.body.lines[0].requiresApproval]).toEqual(['closed', false]);
    await expectBalanced(t);
  });
});

describe('cancel', () => {
  it('before picking releases the reserve; during picking returns picked units to the return cell; packed is refused', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    const early = await placeOrder(w, [{ sku: sku.code, qty: 2 }]);
    await drain(t);
    const c1 = await w.api.post(`/api/shop/v1/orders/${early}/cancel`, {}, { token: w.shop.apiKey });
    expect(c1.body).toMatchObject({ status: 'cancelled', returnedUnits: 0 });
    expect(await reservedOf(early)).toBe(0);
    expect(
      (await w.api.post(`/api/shop/v1/orders/${early}/cancel`, {}, { token: w.shop.apiKey })).body
        .alreadyCancelled,
    ).toBe(true);

    const mid = await placeOrder(w, [{ sku: sku.code, qty: 2 }]);
    await drain(t);
    const task = await startPicking(w);
    await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    const c2 = await w.api.post(`/api/shop/v1/orders/${mid}/cancel`, {}, { token: w.shop.apiKey });
    expect(c2.body.returnedUnits).toBe(1);
    const ret = await t.db.location.findFirstOrThrow({ where: { warehouseId: w.wh.id, kind: 'return' } });
    expect(
      (await t.db.stockBalance.findFirstOrThrow({ where: { locationId: ret.id, skuId: sku.id } })).onHand,
    ).toBe(1);
    const after = await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    expect(after.body.error.code).toBe('ORDER_CANCELLED');

    const late = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await drain(t);
    const t3 = await startPicking(w);
    await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${t3.id}/scan`,
      { lineId: t3.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    await w.api.post(
      `/api/warehouses/${w.wh.id}/packing`,
      { orderRef: late, idempotencyKey: key() },
      { token: w.packer.token },
    );
    const c3 = await w.api.post(`/api/shop/v1/orders/${late}/cancel`, {}, { token: w.shop.apiKey });
    expect([c3.status, c3.body.error.code]).toEqual([422, 'ORDER_NOT_CANCELLABLE']);
    await expectBalanced(t);
  });

  it('acceptance #7 (looped): cancel racing the last scan is all-or-nothing', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 40);
    for (let i = 0; i < 12; i += 1) {
      const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
      await drain(t);
      const task = await startPicking(w);
      const [scan, cancel] = await Promise.all([
        w.api.post(
          `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
          { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, idempotencyKey: key() },
          { token: w.picker1.token },
        ),
        w.api.post(`/api/shop/v1/orders/${id}/cancel`, {}, { token: w.shop.apiKey }),
      ]);
      const status = await orderStatus(t, id);
      const line = await t.db.orderLine.findFirstOrThrow({ where: { orderId: id } });
      if (status === 'cancelled') {
        expect(cancel.status).toBe(200);
        expect(line.reservedQty).toBe(0);
        expect(cancel.body.returnedUnits).toBe(scan.status === 200 ? 1 : 0);
      } else {
        expect([status, scan.status, cancel.status]).toEqual(['picked', 200, 200]);
      }
    }
    await expectBalanced(t);
  });
});

describe('transfers', () => {
  it('stock in transit is available at neither warehouse; after receipt + putaway it is available at the destination', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    const { batchId } = await stockUp(w, sku, 'A-001', 10);
    const dest = await makeWarehouse(w.api, w.admin, { cells: 2 });
    const destStore = await makeStaff(w.api, w.admin, [{ role: 'storekeeper', warehouseId: dest.id }]);
    const cell = await t.db.location.findFirstOrThrow({ where: { warehouseId: w.wh.id, code: 'A-001' } });
    const tr = await w.api.post(
      `/api/warehouses/${w.wh.id}/transfers`,
      {
        toWarehouseId: dest.id,
        lines: [{ cellId: cell.id, skuId: sku.id, batchId, qty: 4 }],
        idempotencyKey: key(),
      },
      { token: w.store.token },
    );
    expect(tr.status, JSON.stringify(tr.body)).toBe(201);
    const view = async () =>
      (await w.api.get(`/api/shop/v1/stock?q=${sku.code}`, { token: w.shop.apiKey })).body.items[0]
        .warehouses as { warehouseId: string; available: number; inTransit: number; receiving: number }[];
    const v1 = await view();
    expect(v1.find((x) => x.warehouseId === w.wh.id)).toMatchObject({ available: 6, inTransit: 0 });
    expect(v1.find((x) => x.warehouseId === dest.id)).toMatchObject({ available: 0, inTransit: 4 });
    const rc = await w.api.post(
      `/api/warehouses/${dest.id}/transfers/${tr.body.transferId}/receive`,
      { lines: [{ skuId: sku.id, batchId, qty: 3 }], idempotencyKey: key() },
      { token: destStore.token },
    );
    expect(rc.body).toEqual({ received: 3, missing: 1 });
    const v2 = await view();
    expect(v2.find((x) => x.warehouseId === dest.id)).toMatchObject({
      available: 0,
      inTransit: 0,
      receiving: 3,
    });
    const pending = (
      await w.api.get(`/api/warehouses/${dest.id}/putaway/pending`, { token: destStore.token })
    ).body.items[0];
    await w.api.post(
      `/api/warehouses/${dest.id}/putaway/confirm`,
      {
        sourceLocationId: pending.sourceLocationId,
        skuId: sku.id,
        batchId,
        qty: 3,
        cellCode: 'A-001',
        idempotencyKey: key(),
      },
      { token: destStore.token },
    );
    expect((await view()).find((x) => x.warehouseId === dest.id)).toMatchObject({
      available: 3,
      receiving: 0,
    });
    await expectBalanced(t);
  });
});
