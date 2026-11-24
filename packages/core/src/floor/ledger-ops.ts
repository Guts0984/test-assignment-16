// Building blocks that change stock. Every change is a ledger row (the trigger updates balances),
// reservations are rows that always agree with balances.reserved, and rows are locked in one
// global order: order -> task -> location -> balance.
import { randomUUID } from 'node:crypto';
import { type Tx } from '@ff/db/client';
import { insertMovements, type MovementRow } from '@ff/db/ledger';
import { type MovementKind } from '@ff/shared/domain';
import { allocateFefo, type StockSlot } from '@ff/shared/rules/fefo';
import { type Effects } from '../effects';
import { markStockChanged } from '../outbox';
import { scheduleAction } from '../scheduled-actions';

export type Ctx = {
  readonly tx: Tx;
  readonly fx: Effects;
  readonly now: Date;
  readonly actorType: 'system' | 'staff' | 'shop';
  readonly actorId: string | null;
  readonly docType: string;
  readonly docId: string;
  readonly windowMs: number;
};

type Mv = {
  readonly kind: MovementKind;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly skuId: string;
  readonly batchId: string;
  readonly onHandDelta: number;
  readonly reservedDelta: number;
  readonly qty: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly reason?: string;
};

export const writeMovements = (ctx: Ctx, rows: readonly Mv[]): Promise<void> => {
  const groupId = randomUUID();
  return insertMovements(
    ctx.tx,
    rows.map((r): MovementRow => ({
      groupId,
      kind: r.kind,
      warehouseId: r.warehouseId,
      locationId: r.locationId,
      skuId: r.skuId,
      batchId: r.batchId,
      onHandDelta: r.onHandDelta,
      reservedDelta: r.reservedDelta,
      qty: r.qty,
      fromLocationId: r.from,
      toLocationId: r.to,
      docType: ctx.docType,
      docId: ctx.docId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      reason: r.reason ?? null,
      at: ctx.now,
    })),
  );
};

/** Moves on-hand stock between two locations of one warehouse (two ledger rows, one group). */
export const transferStock = (
  ctx: Ctx,
  kind: MovementKind,
  m: {
    warehouseId: string;
    from: string;
    to: string;
    skuId: string;
    batchId: string;
    qty: number;
    fromWarehouseId?: string;
  },
): Promise<void> =>
  writeMovements(ctx, [
    {
      kind,
      warehouseId: m.fromWarehouseId ?? m.warehouseId,
      locationId: m.from,
      skuId: m.skuId,
      batchId: m.batchId,
      onHandDelta: -m.qty,
      reservedDelta: 0,
      qty: m.qty,
      from: m.from,
      to: m.to,
    },
    {
      kind,
      warehouseId: m.warehouseId,
      locationId: m.to,
      skuId: m.skuId,
      batchId: m.batchId,
      onHandDelta: m.qty,
      reservedDelta: 0,
      qty: m.qty,
      from: m.from,
      to: m.to,
    },
  ]);

export type LockedSlot = StockSlot & { readonly onHand: number; readonly reserved: number };

/**
 * Reservable slots of one SKU at a warehouse, locked: balance rows FOR UPDATE and their cells
 * FOR SHARE, so a concurrent shortage / count (which locks the cell FOR UPDATE) serialises with us.
 */
export const lockReservableSlots = async (
  tx: Tx,
  warehouseId: string,
  skuId: string,
): Promise<readonly LockedSlot[]> => {
  const rows = await tx.$queryRaw<
    {
      location_id: string;
      batch_id: string;
      on_hand: number;
      reserved: number;
      walk_order: number;
      expires_on: string | null;
      received_at: Date;
    }[]
  >`
    SELECT b.location_id, b.batch_id, b.on_hand, b.reserved, l.walk_order, bt.expires_on::text AS expires_on, bt.received_at
    FROM stock_balances b
    JOIN locations l ON l.id = b.location_id
    JOIN batches bt ON bt.id = b.batch_id
    WHERE b.warehouse_id = ${warehouseId}::uuid AND b.sku_id = ${skuId}::uuid AND l.kind = 'storage'
      AND l.blocked_reason IS NULL AND b.on_hand > b.reserved
    ORDER BY b.location_id, b.batch_id
    FOR UPDATE OF b FOR SHARE OF l`;
  return rows.map((r) => ({
    cellId: r.location_id,
    batchId: r.batch_id,
    expiresOn: r.expires_on,
    batchReceivedAt: r.received_at,
    walkOrder: r.walk_order,
    available: r.on_hand - r.reserved,
    onHand: r.on_hand,
    reserved: r.reserved,
  }));
};

export type LineNeed = {
  readonly orderId: string;
  readonly lineId: string;
  readonly skuId: string;
  readonly missing: number;
};

/** Reserves up to `missing` units of one line by FEFO; returns the allocations made. */
export const reserveLine = async (
  ctx: Ctx,
  warehouseId: string,
  need: LineNeed,
  asOfDate: string,
  minShelfLifeDays: number,
  slots?: readonly LockedSlot[],
) => {
  const candidates = slots ?? (await lockReservableSlots(ctx.tx, warehouseId, need.skuId));
  const { allocations } = allocateFefo(candidates, need.missing, asOfDate, minShelfLifeDays);
  if (allocations.length === 0) return [];
  await writeMovements(
    ctx,
    allocations.map((a) => ({
      kind: 'reserve' as const,
      warehouseId,
      locationId: a.cellId,
      skuId: need.skuId,
      batchId: a.batchId,
      onHandDelta: 0,
      reservedDelta: a.qty,
      qty: a.qty,
      from: a.cellId,
      to: null,
    })),
  );
  for (const a of allocations) {
    await ctx.tx.$executeRaw`
      INSERT INTO order_reservations (order_id, order_line_id, location_id, sku_id, batch_id, qty, created_at)
      VALUES (${need.orderId}::uuid, ${need.lineId}::uuid, ${a.cellId}::uuid, ${need.skuId}::uuid, ${a.batchId}::uuid, ${a.qty}, ${ctx.now})
      ON CONFLICT (order_line_id, location_id, batch_id) DO UPDATE SET qty = order_reservations.qty + EXCLUDED.qty`;
  }
  const total = allocations.reduce((s, a) => s + a.qty, 0);
  await ctx.tx
    .$executeRaw`UPDATE order_lines SET reserved_qty = reserved_qty + ${total} WHERE id = ${need.lineId}::uuid`;
  return allocations;
};

export type ReservationRow = {
  readonly id: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly locationId: string;
  readonly skuId: string;
  readonly batchId: string;
  readonly qty: number;
  readonly warehouseId: string;
};

type RawRes = {
  id: string;
  order_id: string;
  order_line_id: string;
  location_id: string;
  sku_id: string;
  batch_id: string;
  qty: number;
  warehouse_id: string;
};
const toRes = (r: RawRes): ReservationRow => ({
  id: r.id,
  orderId: r.order_id,
  orderLineId: r.order_line_id,
  locationId: r.location_id,
  skuId: r.sku_id,
  batchId: r.batch_id,
  qty: r.qty,
  warehouseId: r.warehouse_id,
});

export const lockOrderReservations = async (tx: Tx, orderId: string): Promise<readonly ReservationRow[]> =>
  (
    await tx.$queryRaw<RawRes[]>`
      SELECT r.id, r.order_id, r.order_line_id, r.location_id, r.sku_id, r.batch_id, r.qty, l.warehouse_id
      FROM order_reservations r JOIN locations l ON l.id = r.location_id
      WHERE r.order_id = ${orderId}::uuid AND r.qty > 0 ORDER BY r.location_id, r.batch_id FOR UPDATE OF r`
  ).map(toRes);

export const lockCellReservations = async (tx: Tx, locationId: string): Promise<readonly ReservationRow[]> =>
  (
    await tx.$queryRaw<RawRes[]>`
      SELECT r.id, r.order_id, r.order_line_id, r.location_id, r.sku_id, r.batch_id, r.qty, l.warehouse_id
      FROM order_reservations r JOIN locations l ON l.id = r.location_id
      WHERE r.location_id = ${locationId}::uuid AND r.qty > 0 ORDER BY r.order_id, r.batch_id FOR UPDATE OF r`
  ).map(toRes);

/** Releases `qty` of one reservation (unreserve ledger row, reservation and line updated). */
export const unreserve = async (ctx: Ctx, r: ReservationRow, qty: number): Promise<void> => {
  if (qty <= 0) return;
  await writeMovements(ctx, [
    {
      kind: 'unreserve',
      warehouseId: r.warehouseId,
      locationId: r.locationId,
      skuId: r.skuId,
      batchId: r.batchId,
      onHandDelta: 0,
      reservedDelta: -qty,
      qty,
      from: r.locationId,
      to: null,
    },
  ]);
  await ctx.tx.$executeRaw`UPDATE order_reservations SET qty = qty - ${qty} WHERE id = ${r.id}::uuid`;
  await ctx.tx.$executeRaw`DELETE FROM order_reservations WHERE id = ${r.id}::uuid AND qty = 0`;
  await ctx.tx
    .$executeRaw`UPDATE order_lines SET reserved_qty = reserved_qty - ${qty} WHERE id = ${r.orderLineId}::uuid`;
};

/** Stock became reservable at a warehouse: waiting orders get a re-reserve pass. */
export const scheduleRereserve = async (
  ctx: Ctx,
  warehouseId: string,
  skuIds: readonly string[],
): Promise<void> => {
  for (const skuId of new Set(skuIds)) {
    const key = `${warehouseId}|${skuId}`;
    await scheduleAction(ctx.tx, { kind: 'rereserve', key, dueAt: ctx.now, payload: { warehouseId, skuId } });
    ctx.fx.actions.push({ kind: 'rereserve', key });
  }
};

export const stockChanged = (ctx: Ctx, skuIds: readonly string[]): Promise<void> =>
  markStockChanged(ctx.tx, ctx.fx, skuIds, ctx.now, ctx.windowMs);

export const virtualLocation = async (
  tx: Tx,
  warehouseId: string,
  kind: 'receiving' | 'packing' | 'return',
): Promise<string> => {
  const [r] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM locations WHERE warehouse_id = ${warehouseId}::uuid AND kind = ${kind}::location_kind`;
  if (r === undefined) throw new Error(`warehouse ${warehouseId} has no ${kind} location`);
  return r.id;
};
