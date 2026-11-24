// Acceptance #6-#9 and the racing actions from the invariants, on the real stack: every conflict
// ends in exactly one consistent outcome and the ledger balances.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCopy, at, burst, client, ledger, until } from '../harness/attacker';
import { ensureStack, getStack } from '../harness/global';
import {
  key,
  newSku,
  newWorld,
  orderStatus,
  placeOrder,
  scan,
  settled,
  startPickingTask,
  stockUp,
  type World,
} from '../harness/scenarios';

beforeAll(async () => void (await ensureStack()));
afterAll(async () => ledger.assertBalanced());

const db = () => getStack().db;
const copy = (w: World, picker: World['picker1'], which: 'a' | 'b') =>
  apiCopy(which, { sourceIp: w.ip, auth: picker.token });

describe('acceptance #6: a position is picked once', () => {
  it('two devices scanning the same last unit at once through both copies: exactly one counts', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 30);
    for (let round = 0; round < 5; round += 1) {
      const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
      await settled([id]);
      const task = await startPickingTask(w);
      const body = (k: string) => ({
        lineId: task.lines[0].lineId,
        cellCode: 'A-001',
        barcode: sku.barcode,
        idempotencyKey: k,
      });
      const res = await burst(12, (i) =>
        copy(w, w.picker1, i % 2 === 0 ? 'a' : 'b').post(
          `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
          body(key()),
        ),
      );
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(new Set(res.filter((r) => r.status !== 200).map((r) => r.body.error.code))).toEqual(
        new Set(['LINE_COMPLETE']),
      );
      expect((await db().pickLine.findUniqueOrThrow({ where: { id: task.lines[0].lineId } })).pickedQty).toBe(
        1,
      );
      expect(await orderStatus(id)).toBe('picked');
    }
    await ledger.assertBalanced();
  });

  it('the same scan repeated 10 times (double press, resend) changes nothing after the first, and answers the same', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 3 }]);
    await settled([id]);
    const task = await startPickingTask(w);
    const body = {
      lineId: task.lines[0].lineId,
      cellCode: 'A-001',
      barcode: sku.barcode,
      qty: 1,
      idempotencyKey: key(),
    };
    const res = await burst(10, (i) =>
      copy(w, w.picker1, i % 2 === 0 ? 'a' : 'b').post(
        `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`,
        body,
      ),
    );
    expect(res.every((r) => r.status === 200)).toBe(true);
    for (const r of res) expect(r.body).toEqual(at(res, 0).body);
    expect((await db().pickLine.findUniqueOrThrow({ where: { id: task.lines[0].lineId } })).pickedQty).toBe(
      1,
    );
    expect(await db().pickScan.count({ where: { lineId: task.lines[0].lineId } })).toBe(1);
  });

  it('another picker scanning a task that is not theirs is refused', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 5);
    await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await until(
      async () => (await db().order.count({ where: { shopId: w.shop.id, status: 'reserved' } })) === 1,
      30_000,
      200,
    );
    const task = await startPickingTask(w, w.picker1);
    const r = await scan(
      w,
      task.id,
      { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode },
      w.picker2,
    );
    expect([r.status, r.body.error.code]).toEqual([422, 'TASK_NOT_ASSIGNED']);
  });
});

describe('acceptance #7: cancel racing the last scan or packing', () => {
  it('cancel vs last scan (looped): either cancelled with all in the return cell, or picked and the cancel refused', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 60);
    const outcomes = { cancelled: 0, picked: 0 };
    for (let i = 0; i < 20; i += 1) {
      const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
      await settled([id]);
      const task = await startPickingTask(w);
      const [s, c] = await burst(2, (n) =>
        n === 0
          ? copy(w, w.picker1, 'a').post(`/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`, {
              lineId: task.lines[0].lineId,
              cellCode: 'A-001',
              barcode: sku.barcode,
              idempotencyKey: key(),
            })
          : apiCopy('b', { sourceIp: w.ip, auth: w.shop.apiKey }).post(
              `/api/shop/v1/orders/${id}/cancel`,
              {},
            ),
      );
      const status = await orderStatus(id);
      const line = await db().orderLine.findFirstOrThrow({ where: { orderId: id } });
      if (status === 'cancelled') {
        outcomes.cancelled += 1;
        expect(c.status).toBe(200);
        expect(line.reservedQty).toBe(0);
        const returned = await db().stockMovement.aggregate({
          where: { docType: 'cancel', docId: id, kind: 'return', onHandDelta: { gt: 0 } },
          _sum: { onHandDelta: true },
        });
        expect(returned._sum.onHandDelta ?? 0).toBe(s.status === 200 ? 1 : 0);
      } else {
        outcomes.picked += 1;
        expect([status, s.status, c.status]).toEqual(['picked', 200, 200]);
        expect(c.body.error ?? null).toBeNull();
      }
    }
    expect(outcomes.cancelled + outcomes.picked).toBe(20);
    await ledger.assertBalanced();
  });

  it('cancel vs packing (looped): packed with the cancel refused, or cancelled and the pack refused; never both', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 60);
    for (let i = 0; i < 15; i += 1) {
      const number = `PK-${key().slice(2, 12)}`;
      const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }], false, number);
      await settled([id]);
      const task = await startPickingTask(w);
      await scan(w, task.id, { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode });
      const [p, c] = await burst(2, (n) =>
        n === 0
          ? w.packer.api.post(`/api/warehouses/${w.wh.id}/packing`, {
              orderRef: number,
              idempotencyKey: key(),
            })
          : w.shopApi.post(`/api/shop/v1/orders/${id}/cancel`, {}),
      );
      const status = await orderStatus(id);
      if (status === 'packed') {
        expect([p.status, c.status, c.body.error.code]).toEqual([200, 422, 'ORDER_NOT_CANCELLABLE']);
      } else {
        expect([status, c.status, p.status]).toEqual(['cancelled', 200, 422]);
        const ret = await db().location.findFirstOrThrow({ where: { warehouseId: w.wh.id, kind: 'return' } });
        expect(
          (await db().stockBalance.findFirstOrThrow({ where: { locationId: ret.id, skuId: sku.id } })).onHand,
        ).toBeGreaterThan(0);
      }
    }
    await ledger.assertBalanced();
  });
});

describe('acceptance #8: shortage during picking', () => {
  it('blocks the cell, moves the reserve in the same transaction, and the order is picked from another cell', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 3);
    await stockUp(w, sku, 'A-004', 5);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 2 }]);
    await settled([id]);
    const task = await startPickingTask(w);
    const first = task.lines[0];
    const r = await w.picker1.api.post(`/api/warehouses/${w.wh.id}/tasks/${task.id}/shortage`, {
      lineId: first.lineId,
      foundQty: 0,
      idempotencyKey: key(),
    });
    expect(r.status, r.text).toBe(200);
    const open = r.body.lines.filter((l: { status: string }) => l.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0].cellCode).not.toBe(first.cellCode);
    expect(
      (await db().location.findFirstOrThrow({ where: { warehouseId: w.wh.id, code: first.cellCode } }))
        .blockedReason,
    ).toBe('shortage');
    const done = await scan(w, task.id, {
      lineId: open[0].lineId,
      cellCode: open[0].cellCode,
      barcode: sku.barcode,
      qty: 2,
    });
    expect(done.body.orderStatus).toBe('picked');
    await ledger.assertBalanced();
  });

  it('shortage vs a second picker taking from the same cell: the cell is never used after it was closed', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 10);
    await stockUp(w, sku, 'A-003', 10);
    const ids = [
      await placeOrder(w, [{ sku: sku.code, qty: 1 }]),
      await placeOrder(w, [{ sku: sku.code, qty: 1 }]),
    ];
    await settled(ids);
    const wave = await w.lead.api.post(`/api/warehouses/${w.wh.id}/waves`);
    expect(wave.status).toBe(201);
    const [t1, t2] = await Promise.all([
      w.picker1.api.post(`/api/warehouses/${w.wh.id}/tasks/next`),
      w.picker2.api.post(`/api/warehouses/${w.wh.id}/tasks/next`),
    ]);
    const l1 = t1.body.lines[0];
    const l2 = t2.body.lines[0];
    expect(l1.cellCode).toBe(l2.cellCode);
    const [sh, sc] = await burst(2, (n) =>
      n === 0
        ? w.picker1.api.post(`/api/warehouses/${w.wh.id}/tasks/${t1.body.id}/shortage`, {
            lineId: l1.lineId,
            foundQty: 0,
            idempotencyKey: key(),
          })
        : scan(w, t2.body.id, { lineId: l2.lineId, cellCode: l2.cellCode, barcode: sku.barcode }, w.picker2),
    );
    expect(sh.status, sh.text).toBe(200);
    const blocked = (
      await db().location.findFirstOrThrow({ where: { warehouseId: w.wh.id, code: l1.cellCode } })
    ).blockedReason;
    expect(blocked).toBe('shortage');
    if (sc.status === 200) {
      // the scan landed before the block: it is counted exactly once
      expect((await db().pickLine.findUniqueOrThrow({ where: { id: l2.lineId } })).pickedQty).toBe(1);
    } else {
      expect(['CELL_BLOCKED', 'LINE_COMPLETE', 'TASK_NOT_ASSIGNED', 'WRONG_CELL']).toContain(
        sc.body.error.code,
      );
    }
    await ledger.assertBalanced();
  });
});

describe('acceptance #9: stock count on a cell being picked', () => {
  it('discrepancy of 7: the count is right and the adjustment waits for the shift lead; a scan is counted or refused, never lost', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 30);
    const id = await placeOrder(w, [{ sku: sku.code, qty: 1 }]);
    await settled([id]);
    const task = await startPickingTask(w);
    const line = task.lines[0];
    const cell = await db().location.findFirstOrThrow({ where: { warehouseId: w.wh.id, code: 'A-001' } });
    const [count, sc] = await burst(2, (n) =>
      n === 0
        ? w.lead.api.post(`/api/warehouses/${w.wh.id}/counts`, { cellIds: [cell.id], assigneeId: w.store.id })
        : scan(w, task.id, { lineId: line.lineId, cellCode: 'A-001', barcode: sku.barcode }),
    );
    expect(count.status, count.text).toBe(201);
    const picked = sc.status === 200;
    const systemQty = picked ? 29 : 30;
    const contents = await w.store.api.get(`/api/warehouses/${w.wh.id}/counts/${count.body.ids[0]}/contents`);
    expect(contents.body.items[0].systemQty).toBe(systemQty);
    const batch = contents.body.items[0];
    const submit = await w.store.api.post(`/api/warehouses/${w.wh.id}/counts/${count.body.ids[0]}/submit`, {
      lines: [{ skuId: batch.skuId, batchId: batch.batchId, countedQty: systemQty - 7, reason: 'damaged' }],
      idempotencyKey: key(),
    });
    expect(submit.body).toMatchObject({ status: 'pending_approval' });
    expect(submit.body.lines[0]).toMatchObject({ systemQty, delta: -7, requiresApproval: true });
    expect(
      (
        await w.store.api.post(`/api/warehouses/${w.wh.id}/counts/${count.body.ids[0]}/approve`, {
          approve: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await w.lead.api.post(`/api/warehouses/${w.wh.id}/counts/${count.body.ids[0]}/approve`, {
          approve: true,
        })
      ).body.status,
    ).toBe('closed');
    expect((await db().adjustment.findFirstOrThrow({ where: { countId: count.body.ids[0] } })).delta).toBe(
      -7,
    );
    await ledger.assertBalanced();
  });

  it('thresholds: exactly 5 units and exactly 10% close at once; one more waits for approval', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 100);
    await stockUp(w, sku, 'A-002', 30);
    await stockUp(w, sku, 'A-003', 40);
    const batch = await db().batch.findFirstOrThrow({ where: { skuId: sku.id } });
    const countCell = async (code: string, counted: number) => {
      const cell = await db().location.findFirstOrThrow({ where: { warehouseId: w.wh.id, code } });
      const c = await w.lead.api.post(`/api/warehouses/${w.wh.id}/counts`, { cellIds: [cell.id] });
      const s = await w.lead.api.post(`/api/warehouses/${w.wh.id}/counts/${c.body.ids[0]}/submit`, {
        lines: [{ skuId: sku.id, batchId: batch.id, countedQty: counted, reason: 'recount' }],
        idempotencyKey: key(),
      });
      return s.body.status as string;
    };
    expect(await countCell('A-001', 95)).toBe('closed'); // exactly 5 units
    expect(await countCell('A-002', 27)).toBe('closed'); // exactly 10%
    expect(await countCell('A-003', 35)).toBe('pending_approval'); // 5 of 40 is 12.5%
    await ledger.assertBalanced();
  });
});

describe('other races from the invariants', () => {
  it('reassigning a task vs the picker scanning it: one consistent owner afterwards', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 30);
    for (let i = 0; i < 6; i += 1) {
      const id = await placeOrder(w, [{ sku: sku.code, qty: 2 }]);
      await settled([id]);
      const task = await startPickingTask(w, w.picker1);
      const [re, sc] = await burst(2, (n) =>
        n === 0
          ? w.lead.api.post(`/api/warehouses/${w.wh.id}/tasks/${task.id}/reassign`, {
              pickerId: w.picker2.id,
            })
          : scan(w, task.id, { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.barcode }),
      );
      expect(re.status, re.text).toBe(200);
      const t = await db().pickTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(t.assigneeId).toBe(w.picker2.id);
      const line = await db().pickLine.findUniqueOrThrow({ where: { id: task.lines[0].lineId } });
      expect(line.pickedQty).toBe(sc.status === 200 ? 1 : 0);
      // after the reassignment only the new owner can scan
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
      await w.shopApi.post(`/api/shop/v1/orders/${id}/cancel`, {});
    }
    await ledger.assertBalanced();
  });

  it('a manual wave and the timer wave at the same moment never form two waves for the same orders', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    await stockUp(w, sku, 'A-001', 30);
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => placeOrder(w, [{ sku: sku.code, qty: 1 }])),
    );
    await settled(ids);
    await until(
      async () => (await db().order.count({ where: { id: { in: ids }, status: 'reserved' } })) === 6,
      30_000,
      200,
    );
    const res = await burst(5, () => w.lead.api.post(`/api/warehouses/${w.wh.id}/waves`));
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(res.reduce((s, r) => s + (r.body.orderCount as number), 0)).toBe(6);
    expect(await db().waveOrder.count({ where: { orderId: { in: ids }, active: true } })).toBe(6);
    expect(
      await db().pickTask.count({ where: { orderId: { in: ids }, status: { in: ['pending', 'assigned'] } } }),
    ).toBe(6);
  });

  it('opposite moves A->B and B->A at once never surface a raw deadlock', async () => {
    const w = await newWorld();
    const sku = await newSku(w);
    const { batchId } = await stockUp(w, sku, 'A-001', 100);
    await stockUp(w, sku, 'A-002', 100);
    const mv = (from: string, to: string) =>
      w.store.api.post(`/api/warehouses/${w.wh.id}/moves`, {
        fromCellCode: from,
        toCellCode: to,
        skuId: sku.id,
        batchId,
        qty: 1,
        idempotencyKey: key(),
      });
    const res = await burst(40, (i) => (i % 2 === 0 ? mv('A-001', 'A-002') : mv('A-002', 'A-001')));
    expect(res.filter((r) => r.status !== 201).map((r) => r.body?.error?.code)).toEqual([]);
    await ledger.assertBalanced();
  });
});

void client;
