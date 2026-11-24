// Proves the database itself refuses states that would break the invariants,
// independent of any application code.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { insertMovements, isBalanced, ledgerReport, type MovementRow } from '../src/ledger';
import { pgCode, SQLSTATE } from '../src/pg-errors';
import { withTx } from '../src/tx';
import { makeSku, makeWarehouseWithCells } from './fixtures';
import { testEnv } from './setup/test-env';

let db: Db;
beforeAll(() => {
  db = createDb({ url: testEnv.DATABASE_URL, poolSize: 10 });
});
afterAll(async () => db.$disconnect());

const mv = (o: Partial<MovementRow> & Pick<MovementRow, 'warehouseId' | 'locationId' | 'skuId' | 'batchId'>): MovementRow => ({
  groupId: randomUUID(),
  kind: 'receipt',
  onHandDelta: 0,
  reservedDelta: 0,
  qty: 1,
  fromLocationId: null,
  toLocationId: null,
  docType: 'test',
  docId: 'doc',
  actorType: 'system',
  actorId: null,
  at: new Date(),
  ...o,
});

const failure = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return pgCode(e) ?? 'unknown';
  }
};

describe('ledger drives balances', () => {
  it('a movement creates and updates the balance in the same transaction', async () => {
    const { wh, cells } = await makeWarehouseWithCells(db, 1);
    const { sku, batch } = await makeSku(db);
    const at = { warehouseId: wh.id, locationId: cells[0]?.id ?? '', skuId: sku.id, batchId: batch.id };
    await withTx(db, (tx) => insertMovements(tx, [mv({ ...at, onHandDelta: 10, qty: 10 })]));
    await withTx(db, (tx) => insertMovements(tx, [mv({ ...at, kind: 'reserve', reservedDelta: 4, qty: 4 })]));
    const b = await db.stockBalance.findFirstOrThrow({ where: { locationId: at.locationId, skuId: sku.id } });
    expect([b.onHand, b.reserved]).toEqual([10, 4]);
  });

  it('refuses negative on-hand: the whole transaction rolls back, ledger included', async () => {
    const { wh, cells } = await makeWarehouseWithCells(db, 1);
    const { sku, batch } = await makeSku(db);
    const at = { warehouseId: wh.id, locationId: cells[0]?.id ?? '', skuId: sku.id, batchId: batch.id };
    await withTx(db, (tx) => insertMovements(tx, [mv({ ...at, onHandDelta: 3, qty: 3 })]));
    const code = await failure(
      withTx(db, (tx) => insertMovements(tx, [mv({ ...at, kind: 'pick', onHandDelta: -4, qty: 4 })])),
    );
    expect(code).toBe(SQLSTATE.checkViolation);
    const rows = await db.stockMovement.count({ where: { locationId: at.locationId } });
    expect(rows).toBe(1);
  });

  it('refuses a negative balance created from nothing', async () => {
    const { wh, cells } = await makeWarehouseWithCells(db, 1);
    const { sku, batch } = await makeSku(db);
    const at = { warehouseId: wh.id, locationId: cells[0]?.id ?? '', skuId: sku.id, batchId: batch.id };
    expect(await failure(withTx(db, (tx) => insertMovements(tx, [mv({ ...at, onHandDelta: -1 })])))).toBe(
      SQLSTATE.checkViolation,
    );
  });

  it('refuses reserving more than on-hand', async () => {
    const { wh, cells } = await makeWarehouseWithCells(db, 1);
    const { sku, batch } = await makeSku(db);
    const at = { warehouseId: wh.id, locationId: cells[0]?.id ?? '', skuId: sku.id, batchId: batch.id };
    await withTx(db, (tx) => insertMovements(tx, [mv({ ...at, onHandDelta: 2, qty: 2 })]));
    expect(
      await failure(withTx(db, (tx) => insertMovements(tx, [mv({ ...at, kind: 'reserve', reservedDelta: 3, qty: 3 })]))),
    ).toBe(SQLSTATE.checkViolation);
  });

  it('100 parallel reservers of 1 unit on 10 units: exactly 10 succeed (row lock via upsert)', async () => {
    const { wh, cells } = await makeWarehouseWithCells(db, 1);
    const { sku, batch } = await makeSku(db);
    const at = { warehouseId: wh.id, locationId: cells[0]?.id ?? '', skuId: sku.id, batchId: batch.id };
    await withTx(db, (tx) => insertMovements(tx, [mv({ ...at, onHandDelta: 10, qty: 10 })]));
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        failure(withTx(db, (tx) => insertMovements(tx, [mv({ ...at, kind: 'reserve', reservedDelta: 1 })]))),
      ),
    );
    expect(results.filter((r) => r === null)).toHaveLength(10);
    expect(results.filter((r) => r !== null).every((r) => r === SQLSTATE.checkViolation)).toBe(true);
    const b = await db.stockBalance.findFirstOrThrow({ where: { locationId: at.locationId, skuId: sku.id } });
    expect(b.reserved).toBe(10);
  });

  it('the ledger is append-only', async () => {
    const { wh, cells } = await makeWarehouseWithCells(db, 1);
    const { sku, batch } = await makeSku(db);
    const at = { warehouseId: wh.id, locationId: cells[0]?.id ?? '', skuId: sku.id, batchId: batch.id };
    await withTx(db, (tx) => insertMovements(tx, [mv({ ...at, onHandDelta: 1 })]));
    expect(await failure(db.stockMovement.updateMany({ where: { locationId: at.locationId }, data: { qty: 99 } }))).not.toBeNull();
    expect(await failure(db.stockMovement.deleteMany({ where: { locationId: at.locationId } }))).not.toBeNull();
  });

  it('a movement with no effect or a non-positive qty is rejected', async () => {
    const { wh, cells } = await makeWarehouseWithCells(db, 1);
    const { sku, batch } = await makeSku(db);
    const at = { warehouseId: wh.id, locationId: cells[0]?.id ?? '', skuId: sku.id, batchId: batch.id };
    expect(await failure(withTx(db, (tx) => insertMovements(tx, [mv({ ...at })])))).toBe(SQLSTATE.checkViolation);
    expect(await failure(withTx(db, (tx) => insertMovements(tx, [mv({ ...at, onHandDelta: 1, qty: 0 })])))).toBe(
      SQLSTATE.checkViolation,
    );
  });

  it('balances equal the ledger sum after all of the above, nothing negative', async () => {
    // Reservation views are not checked here: these raw tests reserve without order rows.
    const r = await ledgerReport(db);
    expect([r.ledgerMismatches, r.negativeBalances]).toEqual([0, 0]);
    expect(isBalanced({ ...r, reservationMismatches: 0, lineMismatches: 0 })).toBe(true);
  });
});

describe('domain constraints', () => {
  it('one open count per cell', async () => {
    const { wh, cells } = await makeWarehouseWithCells(db, 1);
    const data = { warehouseId: wh.id, locationId: cells[0]?.id ?? '', origin: 'manual', createdAt: new Date() };
    await db.stockCount.create({ data });
    expect(await failure(db.stockCount.create({ data }))).toBe(SQLSTATE.uniqueViolation);
    await db.stockCount.updateMany({ where: { locationId: data.locationId }, data: { status: 'closed' } });
    expect(await failure(db.stockCount.create({ data }))).toBeNull();
  });

  it('order line: reserved + picked never exceeds qty', async () => {
    const { shop, sku } = await makeSku(db);
    const order = await db.order.create({
      data: {
        shopId: shop.id,
        externalNumber: randomUUID(),
        payloadHash: 'h',
        deliveryMethod: 'standard',
        address: {},
        customerName: 'x',
        country: 'PL',
        receivedAt: new Date(),
        lines: { create: [{ lineNo: 1, skuId: sku.id, qty: 3 }] },
      },
      include: { lines: true },
    });
    const lineId = order.lines[0]?.id ?? '';
    expect(await failure(db.orderLine.update({ where: { id: lineId }, data: { reservedQty: 2, pickedQty: 1 } }))).toBeNull();
    expect(await failure(db.orderLine.update({ where: { id: lineId }, data: { reservedQty: 3, pickedQty: 1 } }))).toBe(
      SQLSTATE.checkViolation,
    );
  });

  it('order import: one order per (shop, external number)', async () => {
    const { shop } = await makeSku(db);
    const data = {
      shopId: shop.id,
      externalNumber: 'DUP-1',
      payloadHash: 'h',
      deliveryMethod: 'standard' as const,
      address: {},
      customerName: 'x',
      country: 'PL',
      receivedAt: new Date(),
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => failure(db.order.create({ data }))));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === SQLSTATE.uniqueViolation)).toHaveLength(9);
  });

  it('one live pick task per order and one active wave per order', async () => {
    const orderId = randomUUID();
    const waveId = randomUUID();
    const { wh } = await makeWarehouseWithCells(db, 0);
    const task = { waveId, orderId, warehouseId: wh.id, priorityRank: 1, createdAt: new Date() };
    await db.pickTask.create({ data: task });
    expect(await failure(db.pickTask.create({ data: task }))).toBe(SQLSTATE.uniqueViolation);
    await db.waveOrder.create({ data: { waveId, orderId } });
    expect(await failure(db.waveOrder.create({ data: { waveId: randomUUID(), orderId } }))).toBe(SQLSTATE.uniqueViolation);
  });

  it('pick line cannot be picked beyond its quantity', async () => {
    const base = {
      taskId: randomUUID(),
      orderLineId: randomUUID(),
      locationId: randomUUID(),
      skuId: randomUUID(),
      batchId: randomUUID(),
      qty: 2,
      walkOrder: 1,
    };
    const line = await db.pickLine.create({ data: base });
    expect(await failure(db.pickLine.update({ where: { id: line.id }, data: { pickedQty: 3 } }))).toBe(SQLSTATE.checkViolation);
  });

  it('storage cells need positive capacity; cutoff and working days are checked', async () => {
    const { wh } = await makeWarehouseWithCells(db, 0);
    expect(
      await failure(db.location.create({ data: { warehouseId: wh.id, kind: 'storage', code: 'Z', capacityVolumeCm3: 0, capacityWeightG: 1 } })),
    ).toBe(SQLSTATE.checkViolation);
    expect(
      await failure(
        db.warehouse.create({
          data: { code: 'BAD-CUTOFF', name: 'x', country: 'PL', timeZone: 'UTC', cutoffLocal: '25:00', workingDays: [1] },
        }),
      ),
    ).toBe(SQLSTATE.checkViolation);
    expect(
      await failure(
        db.warehouse.create({
          data: { code: 'BAD-DAYS', name: 'x', country: 'PL', timeZone: 'UTC', cutoffLocal: '17:00', workingDays: [8] },
        }),
      ),
    ).toBe(SQLSTATE.checkViolation);
  });

  it('adjustments need a non-blank reason', async () => {
    const data = {
      warehouseId: randomUUID(),
      countId: randomUUID(),
      locationId: randomUUID(),
      skuId: randomUUID(),
      batchId: randomUUID(),
      delta: -1,
      reason: '   ',
      authorId: randomUUID(),
      createdAt: new Date(),
    };
    expect(await failure(db.adjustment.create({ data }))).toBe(SQLSTATE.checkViolation);
  });
});
