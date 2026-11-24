// Acceptance #3, #4, #5 and #13 against the real stack (nginx, two api copies, three workers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, shipDayFor } from '@ff/shared/time/calendar';
import { apiCopy, at, burst, ledger, until } from '../harness/attacker';
import { ensureStack, getStack } from '../harness/global';
import {
  days,
  newSku,
  newWorld,
  orderPayload,
  orderStatus,
  placeOrder,
  settled,
  statuses,
  stockUp,
  uid,
} from '../harness/scenarios';

beforeAll(async () => {
  await ensureStack();
});
afterAll(async () => ledger.assertBalanced());

describe('acceptance #3: 300 simultaneous orders for a SKU with 100 on hand', () => {
  it('reserves exactly 100 through both api copies and three workers, 200 wait, nothing negative', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 60);
    await stockUp(w, sku, 'A-002', 40);
    const targets = [
      apiCopy('a', { sourceIp: w.ip, auth: w.shop.apiKey }),
      apiCopy('b', { sourceIp: w.ip, auth: w.shop.apiKey }),
      w.shopApi,
    ];
    const res = await burst(300, (i) =>
      at(targets, i % 3).post('/api/shop/v1/orders', orderPayload(uid('ORD'), [{ sku: sku.code, qty: 1 }])),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(300);
    const ids = res.map((r) => r.body.orderId as string);
    await settled(ids);
    await until(
      async () => (await statuses(ids)).filter((s) => s === 'awaiting_stock').length === 200,
      60_000,
      250,
    );
    const st = await statuses(ids);
    // 50 ready orders form a wave at once, so reserved orders may already be in_wave
    expect(st.filter((s) => s === 'reserved' || s === 'in_wave')).toHaveLength(100);
    expect(st.filter((s) => s === 'awaiting_stock')).toHaveLength(200);
    const rows = await getStack().db.stockBalance.findMany({ where: { skuId: sku.id } });
    expect(rows.reduce((s, r) => s + r.reserved, 0)).toBe(100);
    expect(rows.every((r) => r.onHand >= 0 && r.reserved >= 0 && r.reserved <= r.onHand)).toBe(true);
    const lines = await getStack().db.orderLine.findMany({ where: { orderId: { in: ids } } });
    expect(lines.filter((l) => l.reservedQty > 1)).toHaveLength(0);
    await ledger.assertBalanced();
  });
});

describe('acceptance #4: batches expiring in 10, 40 and 90 days, shop minimum 30', () => {
  it('reserves from the 40-day batch, never touches the 10-day one, also when 40 runs out partway', async () => {
    const w = await newWorld({ minShelfLifeDays: 30 });
    const sku = await newSku(w, true);
    const b10 = await stockUp(w, sku, 'A-001', 5, { code: 'D10', expiresOn: days(10) });
    const b40 = await stockUp(w, sku, 'A-002', 5, { code: 'D40', expiresOn: days(40) });
    const b90 = await stockUp(w, sku, 'A-003', 5, { code: 'D90', expiresOn: days(90) });
    const first = await placeOrder(w, [{ sku: sku.code, qty: 3 }]);
    await settled([first]);
    const db = getStack().db;
    expect(
      (await db.orderReservation.findMany({ where: { orderId: first } })).map((r) => [r.batchId, r.qty]),
    ).toEqual([[b40.batchId, 3]]);
    const burstIds = (
      await burst(4, () =>
        w.shopApi.post('/api/shop/v1/orders', orderPayload(uid('ORD'), [{ sku: sku.code, qty: 2 }])),
      )
    ).map((r) => r.body.orderId as string);
    await settled(burstIds);
    expect(await db.orderReservation.count({ where: { batchId: b10.batchId } })).toBe(0);
    const used = await db.orderReservation.groupBy({
      by: ['batchId'],
      where: { skuId: sku.id },
      _sum: { qty: true },
    });
    expect(Object.fromEntries(used.map((u) => [u.batchId, u._sum.qty]))).toEqual({
      [b40.batchId]: 5,
      [b90.batchId]: 5,
    });
    expect((await statuses(burstIds)).filter((s) => s === 'reserved')).toHaveLength(3);
    await ledger.assertBalanced();
  });

  it('boundary: a batch with exactly the minimum shelf life is used, one day less is not', async () => {
    const w = await newWorld({ minShelfLifeDays: 30 });
    const sku = await newSku(w, true);
    // shelf life is measured at the projected ship day of the warehouse
    const shipDay = shipDayFor(new Date(), {
      timeZone: 'Europe/Warsaw',
      cutoffLocal: '17:00',
      workingDays: [1, 2, 3, 4, 5],
      holidays: [],
    });
    const exact = await stockUp(w, sku, 'A-001', 1, { code: 'EXACT', expiresOn: addDays(shipDay, 30) });
    const under = await stockUp(w, sku, 'A-002', 1, { code: 'UNDER', expiresOn: addDays(shipDay, 29) });
    const a = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    const b = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await settled([a, b]);
    expect((await statuses([a, b])).sort()).toEqual(['awaiting_stock', 'reserved']);
    const db = getStack().db;
    expect(await db.orderReservation.count({ where: { batchId: exact.batchId } })).toBe(1);
    expect(await db.orderReservation.count({ where: { batchId: under.batchId } })).toBe(0);
  });
});

describe('acceptance #5: receiving 20 units with 50 waiting orders (some express)', () => {
  it('express and the earliest get the stock, nobody twice, ledger balances', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) ids.push(await placeOrder(w, [{ sku: sku.code, qty: 1 }], i % 5 === 2));
    await settled(ids);
    expect((await statuses(ids)).every((s) => s === 'awaiting_stock')).toBe(true);
    // two receipts at the same time, 10 units each
    await Promise.all([stockUp(w, sku, 'A-001', 10), stockUp(w, sku, 'A-002', 10)]);
    await until(async () => (await statuses(ids)).filter((s) => s === 'reserved').length === 20, 60_000, 250);
    const db = getStack().db;
    const rows = await db.order.findMany({ where: { id: { in: ids } }, orderBy: { receivedAt: 'asc' } });
    const express = rows.filter((r) => r.deliveryMethod === 'express');
    const standard = rows.filter((r) => r.deliveryMethod === 'standard');
    const expected = new Set([...express, ...standard.slice(0, 20 - express.length)].map((r) => r.id));
    const got = new Set(rows.filter((r) => r.status === 'reserved').map((r) => r.id));
    expect([...got].sort()).toEqual([...expected].sort());
    const lines = await db.orderLine.findMany({ where: { orderId: { in: ids } } });
    expect(lines.every((l) => l.reservedQty <= 1)).toBe(true);
    expect(lines.reduce((s, l) => s + l.reservedQty, 0)).toBe(20);
    await ledger.assertBalanced();
  });

  it('a cancel racing the re-reserve never leaves a reserve behind', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(await placeOrder(w, [{ sku: sku.code, qty: 1 }]));
    await settled(ids);
    await Promise.all([
      stockUp(w, sku, 'A-001', 5),
      ...ids.slice(0, 5).map((id) => w.shopApi.post(`/api/shop/v1/orders/${id}/cancel`, {})),
    ]);
    await until(
      async () =>
        (await statuses(ids)).filter((s) => s === 'reserved').length +
          (await statuses(ids)).filter((s) => s === 'cancelled').length >=
        5,
      60_000,
      250,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const db = getStack().db;
    for (const id of ids.slice(0, 5)) {
      expect(await orderStatus(id)).toBe('cancelled');
      expect((await db.orderLine.findFirstOrThrow({ where: { orderId: id } })).reservedQty).toBe(0);
    }
    expect(
      (await db.orderReservation.aggregate({ where: { skuId: sku.id }, _sum: { qty: true } }))._sum.qty ?? 0,
    ).toBeLessThanOrEqual(5);
    await ledger.assertBalanced();
  });
});
