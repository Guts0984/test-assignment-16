// The main warehouse flow end to end in-process, and the picking rules around it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../setup/app';
import {
  drain,
  expectBalanced,
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
  t = await startTestApp({ RATE_LIMIT_ENABLED: 'false' });
});
afterAll(async () => t.close());

const takeTask = async (w: World, picker = w.picker1) => {
  const r = await w.api.post(`/api/warehouses/${w.wh.id}/tasks/next`, undefined, { token: picker.token });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const scan = (w: World, taskId: string, body: Record<string, unknown>, picker = w.picker1) =>
  w.api.post(
    `/api/warehouses/${w.wh.id}/tasks/${taskId}/scan`,
    { idempotencyKey: key(), ...body },
    { token: picker.token },
  );

describe('receive -> putaway -> order -> reserve -> wave -> pick -> pack -> label -> ship', () => {
  it('works end to end and the shop gets every status event in version order', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    const orderId = await placeOrder(w, [{ sku: sku.code, qty: 3 }]);
    await drain(t);
    expect(await orderStatus(t, orderId)).toBe('reserved');
    const stock = await w.api.get(`/api/shop/v1/stock?q=${sku.code}`, { token: w.shop.apiKey });
    expect(
      stock.body.items[0].warehouses.find((x: { warehouseId: string }) => x.warehouseId === w.wh.id),
    ).toMatchObject({ onShelf: 10, reserved: 3, available: 7 });

    const wave = await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    expect([wave.status, wave.body.orderCount]).toEqual([201, 1]);
    const task = await takeTask(w);
    expect(await orderStatus(t, orderId)).toBe('picking');
    const line = task.lines[0];
    const cellOk = await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan-cell`,
      { cellCode: 'A-001' },
      { token: w.picker1.token },
    );
    expect(cellOk.status).toBe(200);
    expect(
      (await scan(w, task.id, { lineId: line.lineId, cellCode: 'A-001', barcode: sku.barcode, qty: 2 })).body
        .lineDone,
    ).toBe(false);
    const last = await scan(w, task.id, { lineId: line.lineId, cellCode: 'A-001', barcode: sku.barcode });
    expect(last.body).toMatchObject({ lineDone: true, taskDone: true, orderStatus: 'picked' });

    const pack = await w.api.post(
      `/api/warehouses/${w.wh.id}/packing`,
      { orderRef: task.orderNumber, idempotencyKey: key() },
      { token: w.packer.token },
    );
    expect(pack.status, JSON.stringify(pack.body)).toBe(200);
    const label = await fetch(`${t.base}${pack.body.labelUrl}`, {
      headers: { authorization: `Bearer ${w.packer.token}` },
    });
    expect(label.headers.get('content-type')).toBe('application/pdf');
    expect(label.headers.get('content-disposition')).toBe(`attachment; filename="label-${orderId}.pdf"`);
    expect((await label.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    // The ship day depends on the wall clock (after the cutoff it is a later day); make it due.
    await t.db.$executeRaw`UPDATE orders SET ship_day = CURRENT_DATE - 1 WHERE id = ${orderId}::uuid`;
    const ship = await w.api.post(
      `/api/warehouses/${w.wh.id}/shipments`,
      { orderIds: [orderId], idempotencyKey: key() },
      { token: w.store.token },
    );
    expect(ship.body.shipped).toEqual([orderId]);
    expect(await orderStatus(t, orderId)).toBe('shipped');
    const events = await t.db.webhookEvent.findMany({
      where: { stream: `order:${orderId}` },
      orderBy: { version: 'asc' },
    });
    expect(events.map((e) => (e.payload as { status: string }).status)).toEqual([
      'received',
      'reserved',
      'in_wave',
      'picking',
      'picked',
      'packed',
      'shipped',
    ]);
    expect(events.map((e) => e.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await expectBalanced(t);
  });
});

describe('scan rules', () => {
  it('wrong cell, wrong SKU and wrong batch are refused with a clear code', async () => {
    const w = await world(t);
    const sku = await newSku(w, true);
    const other = await newSku(w);
    const exp = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    await stockUp(w, sku, 'A-001', 5, { code: 'LOT-1', expiresOn: exp });
    await stockUp(w, other, 'A-002', 5);
    await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await drain(t);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    const task = await takeTask(w);
    const lineId = task.lines[0].lineId;
    expect(
      (await scan(w, task.id, { lineId, cellCode: 'A-002', barcode: sku.barcode, batchCode: 'LOT-1' })).body
        .error.code,
    ).toBe('WRONG_CELL');
    expect(
      (await scan(w, task.id, { lineId, cellCode: 'A-001', barcode: other.barcode, batchCode: 'LOT-1' })).body
        .error.code,
    ).toBe('WRONG_SKU');
    expect(
      (await scan(w, task.id, { lineId, cellCode: 'A-001', barcode: sku.barcode, batchCode: 'LOT-2' })).body
        .error.code,
    ).toBe('WRONG_BATCH');
    expect(
      (await scan(w, task.id, { lineId, cellCode: 'A-001', barcode: sku.barcode })).body.error.code,
    ).toBe('WRONG_BATCH');
    expect(
      (
        await w.api.post(
          `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan-cell`,
          { cellCode: 'A-002' },
          { token: w.picker1.token },
        )
      ).body.error.code,
    ).toBe('WRONG_CELL');
    expect(
      (await scan(w, task.id, { lineId, cellCode: 'A-001', barcode: sku.barcode, batchCode: 'LOT-1' }))
        .status,
    ).toBe(200);
    await expectBalanced(t);
  });

  it('the same scan repeated (double press, resend) counts once and returns the same answer', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 5);
    await placeOrder(w, [{ sku: sku.code, qty: 2 }]);
    await drain(t);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    const task = await takeTask(w);
    const body = {
      lineId: task.lines[0].lineId,
      cellCode: 'A-001',
      barcode: sku.barcode,
      idempotencyKey: key(),
    };
    const res = await Promise.all(
      Array.from({ length: 10 }, () =>
        w.api.post(`/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`, body, { token: w.picker1.token }),
      ),
    );
    expect(res.every((r) => r.status === 200)).toBe(true);
    for (const r of res) expect(r.body).toEqual(res[0]?.body);
    expect((await t.db.pickLine.findUniqueOrThrow({ where: { id: body.lineId } })).pickedQty).toBe(1);
    const reuse = await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
      { ...body, qty: 2 },
      { token: w.picker1.token },
    );
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    await expectBalanced(t);
  });

  it('two different scans racing for the last unit: one counts, the other is refused', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 5);
    await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await drain(t);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    const task = await takeTask(w);
    const res = await Promise.all(
      Array.from({ length: 6 }, () =>
        scan(w, task.id, { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode }),
      ),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(new Set(res.filter((r) => r.status !== 200).map((r) => r.body.error.code))).toEqual(
      new Set(['LINE_COMPLETE']),
    );
    expect((await t.db.pickLine.findUniqueOrThrow({ where: { id: task.lines[0].lineId } })).pickedQty).toBe(
      1,
    );
    await expectBalanced(t);
  });

  it('a picker cannot read or scan another picker task; two pickers never get the same task', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await drain(t);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    const [a, b] = await Promise.all([takeTask(w, w.picker1), takeTask(w, w.picker2)]);
    expect(a.id).not.toBe(b.id);
    expect(
      (await w.api.get(`/api/warehouses/${w.wh.id}/tasks/${a.id}`, { token: w.picker2.token })).status,
    ).toBe(404);
    expect(
      (await scan(w, a.id, { lineId: a.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode }, w.picker2))
        .body.error.code,
    ).toBe('TASK_NOT_ASSIGNED');
    expect(
      (await w.api.get(`/api/warehouses/${w.wh.id}/tasks/${a.id}`, { token: w.lead.token })).status,
    ).toBe(200);
    expect(
      (await w.api.post(`/api/warehouses/${w.wh.id}/tasks/next`, undefined, { token: w.picker1.token })).body
        .id,
    ).toBe(a.id);
  });

  it('reassigning a task moves it: the old picker is refused, the new one can scan', async () => {
    const w = await world(t);
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    await placeOrder(w, [{ sku: sku.code, qty: 2 }]);
    await drain(t);
    await w.api.post(`/api/warehouses/${w.wh.id}/waves`, undefined, { token: w.lead.token });
    const task = await takeTask(w, w.picker1);
    const re = await w.api.post(
      `/api/warehouses/${w.wh.id}/tasks/${task.id}/reassign`,
      { pickerId: w.picker2.id },
      { token: w.lead.token },
    );
    expect(re.status).toBe(200);
    expect(
      (
        await scan(
          w,
          task.id,
          { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode },
          w.picker1,
        )
      ).body.error.code,
    ).toBe('TASK_NOT_ASSIGNED');
    expect(
      (
        await scan(
          w,
          task.id,
          { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode },
          w.picker2,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await w.api.post(
          `/api/warehouses/${w.wh.id}/tasks/${task.id}/reassign`,
          { pickerId: w.store.id },
          { token: w.lead.token },
        )
      ).body.error.code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await w.api.post(
          `/api/warehouses/${w.wh.id}/tasks/${task.id}/reassign`,
          { pickerId: w.picker1.id },
          { token: w.picker2.token },
        )
      ).status,
    ).toBe(403);
  });
});
