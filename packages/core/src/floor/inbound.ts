// Receiving, putaway, moves and transfers (ASSIGNMENT "Storekeeper", "Transfers").
import { Prisma, type Tx } from '@ff/db/client';
import { fail, ok, type Result } from '@ff/shared/result';
import { loadOf, suggestCells, type CellCandidate } from '@ff/shared/rules/putaway';
import { localDateOf } from '@ff/shared/time/calendar';
import { type Effects } from '../effects';
import { runTx } from '../tx-result';
import { ctxOf, loadWarehouse, type FloorDeps } from './context';
import { idempotent } from './idempotency';
import {
  scheduleRereserve,
  stockChanged,
  transferStock,
  virtualLocation,
  writeMovements,
} from './ledger-ops';

type Staff = { readonly id: string };

export const createReceipt = async (
  d: FloorDeps,
  warehouseId: string,
  staff: Staff,
  input: { shopId: string; inboundId?: string },
) => {
  if ((await d.db.shop.count({ where: { id: input.shopId } })) === 0)
    return fail('NOT_FOUND', 'shop not found');
  if (
    input.inboundId !== undefined &&
    (await d.db.inboundRequest.count({
      where: { id: input.inboundId, shopId: input.shopId, warehouseId },
    })) === 0
  ) {
    return fail('NOT_FOUND', 'inbound request not found for this shop and warehouse');
  }
  const r = await d.db.receipt.create({
    data: {
      warehouseId,
      shopId: input.shopId,
      inboundId: input.inboundId ?? null,
      createdBy: staff.id,
      createdAt: d.clock.now(),
    },
  });
  return ok({ id: r.id, status: r.status });
};

export type ReceiptLineResult = {
  readonly lineId: string;
  readonly skuId: string;
  readonly batchId: string;
  readonly qty: number;
};

/** One scanned item with quantity (and batch + expiry when the SKU tracks expiry) into the dock. */
export const addReceiptLine = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  receiptId: string,
  staff: Staff,
  input: { barcode: string; qty: number; batchCode?: string; expiresOn?: string; idempotencyKey: string },
): Promise<Result<ReceiptLineResult>> =>
  runTx<ReceiptLineResult>(d.db, outer, (tx, fx) =>
    idempotent(tx, `receipt:${staff.id}`, input.idempotencyKey, { receiptId, ...input }, async () => {
      const now = d.clock.now();
      const [rc] = await tx.$queryRaw<{ shop_id: string; status: string }[]>`
        SELECT shop_id, status FROM receipts WHERE id = ${receiptId}::uuid AND warehouse_id = ${warehouseId}::uuid FOR UPDATE`;
      if (rc === undefined) return fail('NOT_FOUND', 'receipt not found');
      if (rc.status !== 'open') return fail('RECEIPT_STATE', 'the receipt is closed');
      const [sku] = await tx.$queryRaw<{ id: string; tracks_expiry: boolean }[]>`
        SELECT id, tracks_expiry FROM skus WHERE shop_id = ${rc.shop_id}::uuid AND barcode = ${input.barcode}`;
      if (sku === undefined) return fail('UNKNOWN_SKU', 'no SKU of this shop has this barcode');
      if (sku.tracks_expiry && (input.batchCode === undefined || input.expiresOn === undefined)) {
        return fail('BATCH_REQUIRED', 'this SKU tracks expiry: enter batch and expiry date');
      }
      const wh = await loadWarehouse(tx, warehouseId);
      if (sku.tracks_expiry && wh !== null && (input.expiresOn ?? '') <= localDateOf(now, wh.timeZone)) {
        return fail('EXPIRY_IN_PAST', 'the expiry date has already passed');
      }
      const code = sku.tracks_expiry ? (input.batchCode ?? '-') : '-';
      await tx.$executeRaw`
        INSERT INTO batches (sku_id, code, expires_on, received_at)
        VALUES (${sku.id}::uuid, ${code}, ${sku.tracks_expiry ? (input.expiresOn ?? null) : null}::date, ${now})
        ON CONFLICT (sku_id, code) DO NOTHING`;
      const [batch] = await tx.$queryRaw<{ id: string; expires_on: string | null }[]>`
        SELECT id, expires_on::text AS expires_on FROM batches WHERE sku_id = ${sku.id}::uuid AND code = ${code}`;
      if (batch === undefined) throw new Error('batch upsert failed');
      if (sku.tracks_expiry && batch.expires_on !== input.expiresOn) {
        return fail('VALIDATION_FAILED', 'this batch was received before with another expiry date', {
          expiresOn: batch.expires_on,
        });
      }
      const [line] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO receipt_lines (receipt_id, sku_id, batch_id, qty, idempotency_key, created_by, created_at)
        VALUES (${receiptId}::uuid, ${sku.id}::uuid, ${batch.id}::uuid, ${input.qty}, ${`${staff.id}:${input.idempotencyKey}`}, ${staff.id}::uuid, ${now})
        RETURNING id`;
      if (line === undefined) throw new Error('receipt line insert failed');
      const recv = await virtualLocation(tx, warehouseId, 'receiving');
      const ctx = ctxOf(tx, fx, d, { type: 'staff', id: staff.id }, 'receipt', receiptId, now);
      await writeMovements(ctx, [
        {
          kind: 'receipt',
          warehouseId,
          locationId: recv,
          skuId: sku.id,
          batchId: batch.id,
          onHandDelta: input.qty,
          reservedDelta: 0,
          qty: input.qty,
          from: null,
          to: recv,
        },
      ]);
      await stockChanged(ctx, [sku.id]);
      return ok({ lineId: line.id, skuId: sku.id, batchId: batch.id, qty: input.qty });
    }),
  );

export type ReceiptSummary = {
  readonly id: string;
  readonly status: string;
  readonly discrepancies: readonly { skuId: string; expectedQty: number; receivedQty: number }[];
};

/** Closing records every mismatch with the shop's inbound request (over, under, unexpected). */
export const closeReceipt = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  receiptId: string,
): Promise<Result<ReceiptSummary>> =>
  runTx<ReceiptSummary>(d.db, outer, async (tx) => {
    const now = d.clock.now();
    const [rc] = await tx.$queryRaw<{ status: string; inbound_id: string | null }[]>`
      SELECT status, inbound_id FROM receipts WHERE id = ${receiptId}::uuid AND warehouse_id = ${warehouseId}::uuid FOR UPDATE`;
    if (rc === undefined) return fail('NOT_FOUND', 'receipt not found');
    if (rc.status === 'open') {
      await tx.$executeRaw`
        INSERT INTO receipt_discrepancies (receipt_id, sku_id, expected_qty, received_qty, created_at)
        SELECT ${receiptId}::uuid, COALESCE(e.sku_id, r.sku_id), COALESCE(e.qty, 0), COALESCE(r.qty, 0), ${now}
        FROM (SELECT sku_id, expected_qty AS qty FROM inbound_lines WHERE inbound_id = ${rc.inbound_id}::uuid) e
        FULL JOIN (SELECT sku_id, SUM(qty)::int AS qty FROM receipt_lines WHERE receipt_id = ${receiptId}::uuid GROUP BY sku_id) r
          ON r.sku_id = e.sku_id
        WHERE ${rc.inbound_id}::uuid IS NOT NULL AND COALESCE(e.qty, 0) <> COALESCE(r.qty, 0)`;
      await tx.$executeRaw`UPDATE receipts SET status = 'closed', closed_at = ${now} WHERE id = ${receiptId}::uuid`;
      if (rc.inbound_id !== null)
        await tx.$executeRaw`UPDATE inbound_requests SET status = 'received' WHERE id = ${rc.inbound_id}::uuid`;
    }
    const disc = await tx.$queryRaw<{ sku_id: string; expected_qty: number; received_qty: number }[]>`
      SELECT sku_id, expected_qty, received_qty FROM receipt_discrepancies WHERE receipt_id = ${receiptId}::uuid ORDER BY sku_id`;
    return ok({
      id: receiptId,
      status: 'closed',
      discrepancies: disc.map((x) => ({
        skuId: x.sku_id,
        expectedQty: x.expected_qty,
        receivedQty: x.received_qty,
      })),
    });
  });

const sqlCell = (id: string) => Prisma.sql`AND l.id = ${id}::uuid`;

/** Cells with their current load, for putaway suggestions and capacity checks. */
const cellLoads = async (
  tx: Tx | FloorDeps['db'],
  warehouseId: string,
  skuId: string,
  batchId: string,
  onlyCellId?: string,
): Promise<readonly CellCandidate[]> => {
  const rows = await tx.$queryRaw<
    {
      id: string;
      code: string;
      walk_order: number;
      blocked: boolean;
      cap_v: number;
      cap_w: number;
      used_v: number;
      used_w: number;
      same_batch: boolean;
      same_sku: boolean;
      empty: boolean;
    }[]
  >`SELECT l.id, l.code, l.walk_order, l.blocked_reason IS NOT NULL AS blocked,
           l.capacity_volume_cm3::float8 AS cap_v, l.capacity_weight_g::float8 AS cap_w,
           COALESCE(SUM(b.on_hand * (s.length_mm::float8 * s.width_mm * s.height_mm / 1000.0)), 0) AS used_v,
           COALESCE(SUM(b.on_hand * s.weight_g::float8), 0) AS used_w,
           COALESCE(bool_or(b.sku_id = ${skuId}::uuid AND b.batch_id = ${batchId}::uuid AND b.on_hand > 0), false) AS same_batch,
           COALESCE(bool_or(b.sku_id = ${skuId}::uuid AND b.on_hand > 0), false) AS same_sku,
           COALESCE(SUM(b.on_hand), 0) = 0 AS empty
    FROM locations l
    LEFT JOIN stock_balances b ON b.location_id = l.id AND b.on_hand > 0
    LEFT JOIN skus s ON s.id = b.sku_id
    WHERE l.warehouse_id = ${warehouseId}::uuid AND l.kind = 'storage' ${onlyCellId === undefined ? Prisma.empty : sqlCell(onlyCellId)}
    GROUP BY l.id`;
  return rows.map((r) => ({
    cellId: r.id,
    code: r.code,
    walkOrder: r.walk_order,
    blocked: r.blocked,
    capacityVolumeCm3: r.cap_v,
    capacityWeightG: r.cap_w,
    usedVolumeCm3: r.used_v,
    usedWeightG: r.used_w,
    holdsSameBatch: r.same_batch,
    holdsSameSku: r.same_sku,
    isEmpty: r.empty,
  }));
};

const skuLoad = async (tx: Tx | FloorDeps['db'], skuId: string, qty: number) => {
  const [s] = await tx.$queryRaw<{ v: number; w: number }[]>`
    SELECT (length_mm::float8 * width_mm * height_mm / 1000.0) AS v, weight_g::float8 AS w FROM skus WHERE id = ${skuId}::uuid`;
  return s === undefined ? null : loadOf(qty, s.v, s.w);
};

/** Items waiting on the dock or in the return cell. */
export const pendingPutaway = (d: FloorDeps, warehouseId: string) =>
  d.db.$queryRaw<
    {
      location_id: string;
      kind: string;
      sku_id: string;
      sku_code: string;
      barcode: string;
      batch_id: string;
      batch_code: string;
      qty: number;
    }[]
  >`
    SELECT b.location_id, l.kind::text AS kind, b.sku_id, s.code AS sku_code, s.barcode, b.batch_id, bt.code AS batch_code, b.on_hand AS qty
    FROM stock_balances b JOIN locations l ON l.id = b.location_id JOIN skus s ON s.id = b.sku_id JOIN batches bt ON bt.id = b.batch_id
    WHERE b.warehouse_id = ${warehouseId}::uuid AND l.kind IN ('receiving', 'return') AND b.on_hand > 0
    ORDER BY l.kind, s.code LIMIT 500`;

/** Suggested cells: same batch, then same SKU, then empty, by walk order; only unblocked cells with room. */
export const suggestPutaway = async (
  d: FloorDeps,
  warehouseId: string,
  input: { skuId: string; batchId: string; qty: number },
) => {
  const load = await skuLoad(d.db, input.skuId, input.qty);
  if (load === null) return fail('NOT_FOUND', 'SKU not found');
  return ok(
    suggestCells(await cellLoads(d.db, warehouseId, input.skuId, input.batchId), load)
      .slice(0, 5)
      .map((c) => ({
        cellId: c.cellId,
        code: c.code,
        reason: c.holdsSameBatch
          ? 'same batch'
          : c.holdsSameSku
            ? 'same SKU'
            : c.isEmpty
              ? 'empty cell'
              : 'free space',
      })),
  );
};

/** The storekeeper scans the cell and confirms: capacity is checked under the cell lock. */
export const confirmPutaway = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  staff: Staff,
  input: {
    sourceLocationId: string;
    skuId: string;
    batchId: string;
    qty: number;
    cellCode: string;
    idempotencyKey: string;
  },
): Promise<Result<{ readonly cellId: string; readonly qty: number }>> =>
  runTx<{ readonly cellId: string; readonly qty: number }>(d.db, outer, (tx, fx) =>
    idempotent(tx, `putaway:${staff.id}`, input.idempotencyKey, input, async () => {
      const now = d.clock.now();
      const [src] = await tx.$queryRaw<{ id: string; kind: string }[]>`
        SELECT id, kind::text AS kind FROM locations WHERE id = ${input.sourceLocationId}::uuid AND warehouse_id = ${warehouseId}::uuid`;
      if (src === undefined || (src.kind !== 'receiving' && src.kind !== 'return'))
        return fail('NOT_FOUND', 'source must be the dock or the return cell');
      const [cell] = await tx.$queryRaw<{ id: string; kind: string; blocked_reason: string | null }[]>`
        SELECT id, kind::text AS kind, blocked_reason FROM locations WHERE warehouse_id = ${warehouseId}::uuid AND code = ${input.cellCode} FOR UPDATE`;
      if (cell === undefined || cell.kind !== 'storage')
        return fail('WRONG_CELL', 'no storage cell with this code');
      if (cell.blocked_reason !== null)
        return fail('CELL_BLOCKED', 'the cell is closed for putaway (stock count)');
      const load = await skuLoad(tx, input.skuId, input.qty);
      const [c] = await cellLoads(tx, warehouseId, input.skuId, input.batchId, cell.id);
      if (load === null || c === undefined) return fail('NOT_FOUND', 'SKU not found');
      if (
        c.usedVolumeCm3 + load.volumeCm3 > c.capacityVolumeCm3 ||
        c.usedWeightG + load.weightG > c.capacityWeightG
      ) {
        return fail('CAPACITY_EXCEEDED', 'the cell has no room for this quantity');
      }
      const [have] = await tx.$queryRaw<{ on_hand: number }[]>`
        SELECT on_hand FROM stock_balances WHERE location_id = ${src.id}::uuid AND sku_id = ${input.skuId}::uuid AND batch_id = ${input.batchId}::uuid FOR UPDATE`;
      if ((have?.on_hand ?? 0) < input.qty)
        return fail('INSUFFICIENT_STOCK', 'not that many units waiting for putaway');
      const ctx = ctxOf(tx, fx, d, { type: 'staff', id: staff.id }, 'putaway', input.idempotencyKey, now);
      await transferStock(ctx, 'putaway', {
        warehouseId,
        from: src.id,
        to: cell.id,
        skuId: input.skuId,
        batchId: input.batchId,
        qty: input.qty,
      });
      await scheduleRereserve(ctx, warehouseId, [input.skuId]);
      await stockChanged(ctx, [input.skuId]);
      return ok({ cellId: cell.id, qty: input.qty });
    }),
  );

/** Moves free (unreserved) stock between two unblocked storage cells; cells locked in id order. */
export const moveStock = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  staff: Staff,
  input: {
    fromCellCode: string;
    toCellCode: string;
    skuId: string;
    batchId: string;
    qty: number;
    idempotencyKey: string;
  },
): Promise<Result<{ readonly qty: number }>> =>
  runTx<{ readonly qty: number }>(d.db, outer, (tx, fx) =>
    idempotent(tx, `move:${staff.id}`, input.idempotencyKey, input, async () => {
      const cells = await tx.$queryRaw<
        { id: string; code: string; kind: string; blocked_reason: string | null }[]
      >`
        SELECT id, code, kind::text AS kind, blocked_reason FROM locations
        WHERE warehouse_id = ${warehouseId}::uuid AND code IN (${input.fromCellCode}, ${input.toCellCode}) ORDER BY id FOR UPDATE`;
      const from = cells.find((c) => c.code === input.fromCellCode);
      const to = cells.find((c) => c.code === input.toCellCode);
      if (from === undefined || to === undefined || from.kind !== 'storage' || to.kind !== 'storage')
        return fail('WRONG_CELL', 'both cells must be storage cells of this warehouse');
      if (from.blocked_reason !== null || to.blocked_reason !== null)
        return fail('CELL_BLOCKED', 'a cell is closed (stock count)');
      const [bal] = await tx.$queryRaw<{ on_hand: number; reserved: number }[]>`
        SELECT on_hand, reserved FROM stock_balances WHERE location_id = ${from.id}::uuid AND sku_id = ${input.skuId}::uuid AND batch_id = ${input.batchId}::uuid FOR UPDATE`;
      if ((bal?.on_hand ?? 0) - (bal?.reserved ?? 0) < input.qty)
        return fail('INSUFFICIENT_STOCK', 'not enough free (unreserved) stock in the source cell');
      const load = await skuLoad(tx, input.skuId, input.qty);
      const [c] = await cellLoads(tx, warehouseId, input.skuId, input.batchId, to.id);
      if (load === null || c === undefined) return fail('NOT_FOUND', 'SKU not found');
      if (
        c.usedVolumeCm3 + load.volumeCm3 > c.capacityVolumeCm3 ||
        c.usedWeightG + load.weightG > c.capacityWeightG
      ) {
        return fail('CAPACITY_EXCEEDED', 'the target cell has no room');
      }
      const ctx = ctxOf(
        tx,
        fx,
        d,
        { type: 'staff', id: staff.id },
        'move',
        input.idempotencyKey,
        d.clock.now(),
      );
      await transferStock(ctx, 'move', {
        warehouseId,
        from: from.id,
        to: to.id,
        skuId: input.skuId,
        batchId: input.batchId,
        qty: input.qty,
      });
      return ok({ qty: input.qty });
    }),
  );

/** Ships free stock to another warehouse: it sits in a transit location, available nowhere. */
export const createTransfer = (
  d: FloorDeps,
  outer: Effects,
  fromWarehouseId: string,
  staff: Staff,
  input: {
    toWarehouseId: string;
    lines: readonly { cellId: string; skuId: string; batchId: string; qty: number }[];
    idempotencyKey: string;
  },
): Promise<Result<{ readonly transferId: string }>> =>
  runTx<{ readonly transferId: string }>(d.db, outer, (tx, fx) =>
    idempotent(tx, `transfer:${staff.id}`, input.idempotencyKey, input, async () => {
      if (input.toWarehouseId === fromWarehouseId)
        return fail('VALIDATION_FAILED', 'source and destination warehouse must differ');
      if ((await tx.warehouse.count({ where: { id: input.toWarehouseId } })) === 0)
        return fail('NOT_FOUND', 'destination warehouse not found');
      const now = d.clock.now();
      const [t] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO transfers (from_warehouse_id, to_warehouse_id, status, created_by, idempotency_key, created_at)
        VALUES (${fromWarehouseId}::uuid, ${input.toWarehouseId}::uuid, 'in_transit', ${staff.id}::uuid, ${`${staff.id}:${input.idempotencyKey}`}, ${now}) RETURNING id`;
      if (t === undefined) throw new Error('transfer insert failed');
      const [transit] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO locations (warehouse_id, kind, code, walk_order, transfer_id, created_at)
        VALUES (${input.toWarehouseId}::uuid, 'transit', ${`TRANSIT-${t.id.slice(0, 8).toUpperCase()}`}, 0, ${t.id}::uuid, ${now}) RETURNING id`;
      if (transit === undefined) throw new Error('transit location insert failed');
      await tx.$executeRaw`UPDATE transfers SET transit_location_id = ${transit.id}::uuid WHERE id = ${t.id}::uuid`;
      const ctx = ctxOf(tx, fx, d, { type: 'staff', id: staff.id }, 'transfer', t.id, now);
      for (const l of [...input.lines].sort((a, b) => (a.cellId < b.cellId ? -1 : 1))) {
        const [cell] = await tx.$queryRaw<{ blocked_reason: string | null; kind: string }[]>`
          SELECT blocked_reason, kind::text AS kind FROM locations WHERE id = ${l.cellId}::uuid AND warehouse_id = ${fromWarehouseId}::uuid FOR UPDATE`;
        if (cell === undefined || cell.kind !== 'storage')
          return fail('WRONG_CELL', 'cell not found in the source warehouse');
        if (cell.blocked_reason !== null) return fail('CELL_BLOCKED', 'a cell is closed (stock count)');
        const [bal] = await tx.$queryRaw<{ on_hand: number; reserved: number }[]>`
          SELECT on_hand, reserved FROM stock_balances WHERE location_id = ${l.cellId}::uuid AND sku_id = ${l.skuId}::uuid AND batch_id = ${l.batchId}::uuid FOR UPDATE`;
        if ((bal?.on_hand ?? 0) - (bal?.reserved ?? 0) < l.qty)
          return fail('INSUFFICIENT_STOCK', 'not enough free stock to transfer');
        await tx.$executeRaw`INSERT INTO transfer_lines (transfer_id, sku_id, batch_id, qty) VALUES (${t.id}::uuid, ${l.skuId}::uuid, ${l.batchId}::uuid, ${l.qty})`;
        await transferStock(ctx, 'transfer_out', {
          warehouseId: input.toWarehouseId,
          fromWarehouseId,
          from: l.cellId,
          to: transit.id,
          skuId: l.skuId,
          batchId: l.batchId,
          qty: l.qty,
        });
      }
      await stockChanged(
        ctx,
        input.lines.map((l) => l.skuId),
      );
      return ok({ transferId: t.id });
    }),
  );

/** The destination receives: units go to its dock (then putaway); anything missing is written off. */
export const receiveTransfer = (
  d: FloorDeps,
  outer: Effects,
  toWarehouseId: string,
  transferId: string,
  staff: Staff,
  input: { lines: readonly { skuId: string; batchId: string; qty: number }[]; idempotencyKey: string },
): Promise<Result<{ readonly received: number; readonly missing: number }>> =>
  runTx<{ readonly received: number; readonly missing: number }>(d.db, outer, (tx, fx) =>
    idempotent(tx, `transfer-in:${staff.id}`, input.idempotencyKey, { transferId, ...input }, async () => {
      const now = d.clock.now();
      const [t] = await tx.$queryRaw<
        { status: string; transit_location_id: string | null; from_warehouse_id: string }[]
      >`
        SELECT status, transit_location_id, from_warehouse_id FROM transfers WHERE id = ${transferId}::uuid AND to_warehouse_id = ${toWarehouseId}::uuid FOR UPDATE`;
      if (t === undefined || t.transit_location_id === null) return fail('NOT_FOUND', 'transfer not found');
      if (t.status !== 'in_transit') return fail('TRANSFER_STATE', 'the transfer was already received');
      const sent = await tx.$queryRaw<{ id: string; sku_id: string; batch_id: string; qty: number }[]>`
        SELECT id, sku_id, batch_id, qty FROM transfer_lines WHERE transfer_id = ${transferId}::uuid`;
      const got = new Map(input.lines.map((l) => [`${l.skuId}/${l.batchId}`, l.qty]));
      if ([...got.keys()].some((k) => !sent.some((s) => `${s.sku_id}/${s.batch_id}` === k)))
        return fail('VALIDATION_FAILED', 'an item was not part of this transfer');
      const recv = await virtualLocation(tx, toWarehouseId, 'receiving');
      const ctx = ctxOf(tx, fx, d, { type: 'staff', id: staff.id }, 'transfer', transferId, now);
      const totals = { received: 0, missing: 0 };
      for (const s of sent) {
        const q = got.get(`${s.sku_id}/${s.batch_id}`) ?? 0;
        if (q > s.qty) return fail('VALIDATION_FAILED', 'received more than was sent');
        if (q > 0)
          await transferStock(ctx, 'transfer_in', {
            warehouseId: toWarehouseId,
            from: t.transit_location_id,
            to: recv,
            skuId: s.sku_id,
            batchId: s.batch_id,
            qty: q,
          });
        if (q < s.qty) {
          await writeMovements(ctx, [
            {
              kind: 'adjustment',
              warehouseId: toWarehouseId,
              locationId: t.transit_location_id,
              skuId: s.sku_id,
              batchId: s.batch_id,
              onHandDelta: q - s.qty,
              reservedDelta: 0,
              qty: s.qty - q,
              from: t.transit_location_id,
              to: null,
              reason: 'lost in transit',
            },
          ]);
        }
        await tx.$executeRaw`UPDATE transfer_lines SET received_qty = ${q} WHERE id = ${s.id}::uuid`;
        totals.received += q;
        totals.missing += s.qty - q;
      }
      await tx.$executeRaw`UPDATE transfers SET status = 'received', received_at = ${now} WHERE id = ${transferId}::uuid`;
      await stockChanged(
        ctx,
        sent.map((s) => s.sku_id),
      );
      return ok(totals);
    }),
  );
