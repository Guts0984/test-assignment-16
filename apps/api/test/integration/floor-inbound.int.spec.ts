// Receiving, putaway capacity, moves, cutoff on packing, dashboard and the period report.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeTestClock } from '@ff/core/clock';
import { startTestApp, type TestApp } from '../setup/app';
import { login } from '../setup/fixtures';
import { drain, expectBalanced, key, newSku, placeOrder, stockUp, world } from '../setup/floor';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({
    RATE_LIMIT_ENABLED: 'false',
    TEST_CLOCK_ENABLED: 'true',
    TEST_CONTROL_TOKEN: 'test-control-token-123',
  });
});
afterAll(async () => {
  await changeTestClock(t.db, { reset: true });
  await t.close();
});

describe('receiving', () => {
  it('records discrepancies against the inbound request: over, under and unexpected', async () => {
    const w = await world(t);
    const [a, b, c] = [await newSku(w), await newSku(w), await newSku(w)];
    const inbound = await w.api.post(
      '/api/shop/v1/inbound',
      {
        warehouseId: w.wh.id,
        reference: `IN-${key()}`.slice(0, 40),
        lines: [
          { sku: a.code, qty: 10 },
          { sku: b.code, qty: 5 },
        ],
      },
      { token: w.shop.apiKey },
    );
    expect(inbound.status, JSON.stringify(inbound.body)).toBe(201);
    const rc = await w.api.post(
      `/api/warehouses/${w.wh.id}/receipts`,
      { shopId: w.shop.id, inboundId: inbound.body.id },
      { token: w.store.token },
    );
    const add = (sku: { barcode: string }, qty: number) =>
      w.api.post(
        `/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/lines`,
        { barcode: sku.barcode, qty, idempotencyKey: key() },
        { token: w.store.token },
      );
    await add(a, 12);
    await add(c, 3);
    const closed = await w.api.post(`/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/close`, undefined, {
      token: w.store.token,
    });
    const by = Object.fromEntries(
      closed.body.discrepancies.map((d: { skuId: string; expectedQty: number; receivedQty: number }) => [
        d.skuId,
        [d.expectedQty, d.receivedQty],
      ]),
    );
    expect(by).toEqual({ [a.id]: [10, 12], [b.id]: [5, 0], [c.id]: [0, 3] });
    const seen = await w.api.get(`/api/shop/v1/inbound/${inbound.body.id}`, { token: w.shop.apiKey });
    expect(seen.body.discrepancies).toHaveLength(3);
    expect(
      (
        await w.api.post(
          `/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/lines`,
          { barcode: a.barcode, qty: 1, idempotencyKey: key() },
          { token: w.store.token },
        )
      ).body.error.code,
    ).toBe('RECEIPT_STATE');
    await expectBalanced(t);
  });

  it('expiry tracking: batch and expiry are required, a past expiry is refused, the same key is one receipt line', async () => {
    const w = await world(t);
    const sku = await newSku(w, true);
    const rc = await w.api.post(
      `/api/warehouses/${w.wh.id}/receipts`,
      { shopId: w.shop.id },
      { token: w.store.token },
    );
    const post = (body: object) =>
      w.api.post(`/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/lines`, body, { token: w.store.token });
    expect((await post({ barcode: sku.barcode, qty: 1, idempotencyKey: key() })).body.error.code).toBe(
      'BATCH_REQUIRED',
    );
    expect(
      (
        await post({
          barcode: sku.barcode,
          qty: 1,
          batchCode: 'L1',
          expiresOn: '2020-01-01',
          idempotencyKey: key(),
        })
      ).body.error.code,
    ).toBe('EXPIRY_IN_PAST');
    expect((await post({ barcode: 'NOPE', qty: 1, idempotencyKey: key() })).body.error.code).toBe(
      'UNKNOWN_SKU',
    );
    const same = {
      barcode: sku.barcode,
      qty: 4,
      batchCode: 'L1',
      expiresOn: '2099-01-01',
      idempotencyKey: key(),
    };
    const res = await Promise.all(Array.from({ length: 6 }, () => post(same)));
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(await t.db.receiptLine.count({ where: { receiptId: rc.body.id } })).toBe(1);
    expect((await post({ ...same, idempotencyKey: key(), expiresOn: '2098-01-01' })).status).toBe(400);
    await expectBalanced(t);
  });
});

describe('putaway and moves', () => {
  it('suggests the same-batch cell first, refuses a cell over capacity and a blocked cell, and cannot move reserved stock', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    const { batchId } = await stockUp(w, sku, 'A-002', 5);
    const rc = await w.api.post(
      `/api/warehouses/${w.wh.id}/receipts`,
      { shopId: w.shop.id },
      { token: w.store.token },
    );
    await w.api.post(
      `/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/lines`,
      { barcode: sku.barcode, qty: 3, idempotencyKey: key() },
      { token: w.store.token },
    );
    const pending = (
      await w.api.get(`/api/warehouses/${w.wh.id}/putaway/pending`, { token: w.store.token })
    ).body.items.find((i: { skuId: string }) => i.skuId === sku.id);
    const sug = await w.api.post(
      `/api/warehouses/${w.wh.id}/putaway/suggest`,
      { sourceLocationId: pending.sourceLocationId, skuId: sku.id, batchId, qty: 3 },
      { token: w.store.token },
    );
    expect(sug.body.items[0]).toMatchObject({ code: 'A-002', reason: 'same batch' });
    const confirm = (cellCode: string, qty: number) =>
      w.api.post(
        `/api/warehouses/${w.wh.id}/putaway/confirm`,
        {
          sourceLocationId: pending.sourceLocationId,
          skuId: sku.id,
          batchId,
          qty,
          cellCode,
          idempotencyKey: key(),
        },
        { token: w.store.token },
      );
    expect((await confirm('NOPE-1', 1)).body.error.code).toBe('WRONG_CELL');
    expect((await confirm('A-003', 99)).body.error.code).toBe('INSUFFICIENT_STOCK');
    await t.db
      .$executeRaw`UPDATE locations SET capacity_volume_cm3 = 1 WHERE warehouse_id = ${w.wh.id}::uuid AND code = 'A-004'`;
    expect((await confirm('A-004', 2)).body.error.code).toBe('CAPACITY_EXCEEDED');
    await t.db
      .$executeRaw`UPDATE locations SET blocked_reason = 'count' WHERE warehouse_id = ${w.wh.id}::uuid AND code = 'A-005'`;
    expect((await confirm('A-005', 1)).body.error.code).toBe('CELL_BLOCKED');
    expect((await confirm('A-003', 3)).status).toBe(201);
    await placeOrder(w, [{ sku: sku.code, qty: 4 }]);
    await drain(t);
    const mv = (from: string, to: string, qty: number) =>
      w.api.post(
        `/api/warehouses/${w.wh.id}/moves`,
        { fromCellCode: from, toCellCode: to, skuId: sku.id, batchId, qty, idempotencyKey: key() },
        { token: w.store.token },
      );
    expect((await mv('A-002', 'A-006', 5)).body.error.code).toBe('INSUFFICIENT_STOCK');
    await expectBalanced(t);
  });

  it('opposite moves A->B and B->A at once never surface a deadlock error', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    const { batchId } = await stockUp(w, sku, 'A-001', 200);
    await stockUp(w, sku, 'A-002', 200);
    const mv = (from: string, to: string) =>
      w.api.post(
        `/api/warehouses/${w.wh.id}/moves`,
        { fromCellCode: from, toCellCode: to, skuId: sku.id, batchId, qty: 1, idempotencyKey: key() },
        { token: w.store.token },
      );
    const res = await Promise.all(
      Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? mv('A-001', 'A-002') : mv('A-002', 'A-001'))),
    );
    expect(res.filter((r) => r.status !== 201).map((r) => r.body.error?.code)).toEqual([]);
    await expectBalanced(t);
  });
});

describe('cutoff on packing (acceptance #10, with the shared test clock)', () => {
  const pack = async (iso: string) => {
    const w = await world(t, { timeZone: 'Europe/Warsaw' });
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 3);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await drain(t);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    const task = (
      await w.api.post(`/api/warehouses/${w.wh.id}/tasks/next`, undefined, { token: w.picker1.token })
    ).body;
    await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode, idempotencyKey: key() },
      { token: w.picker1.token },
    );
    await changeTestClock(t.db, { setTo: new Date(iso) });
    await new Promise((r) => setTimeout(r, 1200));
    const token = await login(w.api, w.packer.email);
    const r = await w.api.post(
      `/api/warehouses/${w.wh.id}/packing`,
      { orderRef: id, idempotencyKey: key() },
      { token },
    );
    await changeTestClock(t.db, { reset: true });
    return r.body.shipDay as string;
  };

  it('Friday 17:01 Warsaw ships Monday; 16:59:59 ships the same day', async () => {
    expect(await pack('2026-11-27T16:01:00Z')).toBe('2026-11-30');
    expect(await pack('2026-11-27T15:59:30Z')).toBe('2026-11-27');
  });
});

describe('dashboard and report', () => {
  it('dashboard shows statuses, waves, pickers, at-risk orders and server time-to-cutoff', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 5);
    await placeOrder(w, [{ sku: sku.code, qty: 1 }], true);
    await drain(t);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    await w.api.post(`/api/warehouses/${w.wh.id}/tasks/next`, undefined, { token: w.picker1.token });
    const d = (await w.api.get(`/api/warehouses/${w.wh.id}/dashboard`, { token: w.lead.token })).body;
    expect(d.ordersByStatus.picking).toBe(1);
    expect(d.waves[0]).toMatchObject({ trigger: 'manual', orderCount: 1 });
    expect(d.pickers.find((p: { staffId: string }) => p.staffId === w.picker1.id)).toMatchObject({
      taskId: expect.any(String),
      lines: 1,
    });
    expect(Math.abs(Date.parse(d.serverTime) - Date.now())).toBeLessThan(5000);
    expect(typeof d.nextCutoff.msLeft).toBe('number');
  });

  it('report: orders in period, median and p90 from a known fixture, shortages and adjustments, filters', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    const shop = w.shop.id;
    const mk = async (n: number, hours: number) => {
      const received = new Date('2026-05-10T08:00:00Z');
      await t.db.$executeRaw`
        INSERT INTO orders (shop_id, external_number, payload_hash, status, delivery_method, address, customer_name, country, warehouse_id,
                            received_at, target_cutoff_at, packed_at, shipped_at, status_version)
        VALUES (${shop}::uuid, ${`R-${w.wh.code}-${n}`}, 'h', 'shipped', 'standard', '{}'::jsonb, 'x', 'PL', ${w.wh.id}::uuid, ${received},
                ${new Date(received.getTime() + 6 * 3600_000)}, ${new Date(received.getTime() + (n % 2 === 0 ? 3 : 9) * 3600_000)},
                ${new Date(received.getTime() + hours * 3600_000)}, 7)`;
    };
    for (const [i, h] of [1, 2, 3, 4, 10].entries()) await mk(i + 1, h);
    await t.db
      .$executeRaw`INSERT INTO shortages (warehouse_id, task_id, line_id, location_id, sku_id, batch_id, picker_id, expected_qty, found_qty, created_at)
      VALUES (${w.wh.id}::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ${sku.id}::uuid, gen_random_uuid(), ${w.picker1.id}::uuid, 5, 2, '2026-05-11T10:00:00Z')`;
    const q = `from=2026-05-01&to=2026-05-31&warehouseId=${w.wh.id}`;
    const r = (await w.api.get(`/api/reports/summary?${q}`, { token: w.lead.token })).body;
    expect(r.orders).toMatchObject({ shipped: 5, onTime: 2, medianMinutes: 180, p90Minutes: 456 });
    expect(r.shortages).toEqual([expect.objectContaining({ staffId: w.picker1.id, events: 1, units: 3 })]);
    const narrow = (
      await w.api.get(`/api/reports/summary?from=2026-06-01&to=2026-06-30&warehouseId=${w.wh.id}`, {
        token: w.lead.token,
      })
    ).body;
    expect(narrow.orders.shipped).toBe(0);
    const other = (
      await w.api.get(`/api/reports/summary?${q}&staffId=${w.picker2.id}`, { token: w.lead.token })
    ).body;
    expect(other.shortages).toEqual([]);
  });
});
