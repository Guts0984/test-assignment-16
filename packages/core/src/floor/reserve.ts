// Reservation (ASSIGNMENT "Reserve", "Batches", "Re-reserve"; invariants 2 and 3).
// One warehouse per order; FEFO with the shop's minimum shelf life; partial reserve -> awaiting_stock.
import { type Tx } from '@ff/db/client';
import { ok, type Result } from '@ff/shared/result';
import { availableEligible } from '@ff/shared/rules/fefo';
import { selectWarehouse } from '@ff/shared/rules/warehouse-select';
import { cutoffInstant, shipDayFor } from '@ff/shared/time/calendar';
import { type Effects } from '../effects';
import { lockOrder, transition, type LockedOrder } from '../orders/transition';
import { scheduleAction } from '../scheduled-actions';
import { runTx } from '../tx-result';
import { ctxOf, loadWarehouse, loadWarehouses, SYSTEM, type FloorDeps } from './context';
import {
  lockOrderReservations,
  lockReservableSlots,
  reserveLine,
  scheduleRereserve,
  stockChanged,
  unreserve,
  type Ctx,
} from './ledger-ops';

type OrderInfo = {
  country: string;
  lat: number | null;
  lon: number | null;
  received_at: Date;
  all_or_nothing: boolean;
  partial_reserve_expires_at: Date | null;
  min_shelf_life_days: number;
};
type LineRow = { id: string; sku_id: string; qty: number; reserved_qty: number; picked_qty: number };

const lines = (tx: Tx, orderId: string) =>
  tx.$queryRaw<
    LineRow[]
  >`SELECT id, sku_id, qty, reserved_qty, picked_qty FROM order_lines WHERE order_id = ${orderId}::uuid ORDER BY sku_id, id`;

/** Chooses the warehouse (no locks; a cheap estimate) and fixes the target cutoff. */
const assignWarehouse = async (
  tx: Tx,
  order: LockedOrder,
  info: OrderInfo,
  ls: readonly LineRow[],
  now: Date,
): Promise<string | null> => {
  const whs = await loadWarehouses(tx);
  const skuIds = ls.map((l) => l.sku_id);
  const bal = await tx.$queryRaw<
    {
      warehouse_id: string;
      sku_id: string;
      location_id: string;
      batch_id: string;
      avail: number;
      walk_order: number;
      expires_on: string | null;
      received_at: Date;
    }[]
  >`SELECT b.warehouse_id, b.sku_id, b.location_id, b.batch_id, (b.on_hand - b.reserved) AS avail, l.walk_order,
           bt.expires_on::text AS expires_on, bt.received_at
    FROM stock_balances b JOIN locations l ON l.id = b.location_id JOIN batches bt ON bt.id = b.batch_id
    WHERE b.sku_id = ANY(${skuIds}::uuid[]) AND l.kind = 'storage' AND l.blocked_reason IS NULL AND b.on_hand > b.reserved`;
  const candidates = whs.map((w) => {
    const asOf = shipDayFor(now, w);
    return {
      warehouseId: w.id,
      country: w.country,
      location: w.lat === null || w.lon === null ? null : { lat: w.lat, lon: w.lon },
      coverableByLine: ls.map((l) =>
        availableEligible(
          bal
            .filter((b) => b.warehouse_id === w.id && b.sku_id === l.sku_id)
            .map((b) => ({
              cellId: b.location_id,
              batchId: b.batch_id,
              expiresOn: b.expires_on,
              batchReceivedAt: b.received_at,
              walkOrder: b.walk_order,
              available: b.avail,
            })),
          asOf,
          info.min_shelf_life_days,
        ),
      ),
    };
  });
  // No warehouse holds any of it: leave the order unassigned. Whichever warehouse receives stock
  // first picks it up (re-reserve), instead of binding it to an arbitrary warehouse by tie-break.
  if (!candidates.some((c) => c.coverableByLine.some((q) => q > 0))) return null;
  const choice = selectWarehouse(candidates, {
    lineQty: ls.map((l) => l.qty),
    country: info.country,
    location: info.lat === null || info.lon === null ? null : { lat: info.lat, lon: info.lon },
  });
  if (choice === null) return null;
  const wh = whs.find((w) => w.id === choice.warehouseId);
  if (wh === undefined) return null;
  const target = cutoffInstant(shipDayFor(info.received_at, wh), wh);
  await tx.$executeRaw`UPDATE orders SET warehouse_id = ${wh.id}::uuid, target_cutoff_at = ${target} WHERE id = ${order.id}::uuid`;
  return wh.id;
};

export type ReserveOutcome = { readonly status: string; readonly reservedUnits: number };

/** Reserves what is missing for a locked order in received / awaiting_stock. */
export const reserveLocked = async (
  ctx: Ctx,
  d: FloorDeps,
  orderIn: LockedOrder,
): Promise<Result<ReserveOutcome>> => {
  const { tx, now } = ctx;
  const [info] = await tx.$queryRaw<OrderInfo[]>`
    SELECT o.country, o.lat, o.lon, o.received_at, o.all_or_nothing, o.partial_reserve_expires_at, s.min_shelf_life_days
    FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = ${orderIn.id}::uuid`;
  if (info === undefined) return ok({ status: orderIn.status, reservedUnits: 0 });
  const ls = await lines(tx, orderIn.id);
  const warehouseId = orderIn.warehouseId ?? (await assignWarehouse(tx, orderIn, info, ls, now));
  if (warehouseId === null) {
    if (orderIn.status !== 'received') return ok({ status: orderIn.status, reservedUnits: 0 });
    const parked = await transition(tx, ctx.fx, orderIn, {
      to: 'awaiting_stock',
      actor: 'system',
      actorId: null,
      now,
    });
    return parked.ok ? ok({ status: 'awaiting_stock', reservedUnits: 0 }) : parked;
  }
  const order = { ...orderIn, warehouseId };
  const wh = await loadWarehouse(tx, warehouseId);
  if (wh === null) return ok({ status: order.status, reservedUnits: 0 });
  const asOf = shipDayFor(now, wh);
  const needs = ls
    .map((l) => ({
      orderId: order.id,
      lineId: l.id,
      skuId: l.sku_id,
      missing: l.qty - l.reserved_qty - l.picked_qty,
    }))
    .filter((n) => n.missing > 0);
  const slotsBySku = new Map<string, Awaited<ReturnType<typeof lockReservableSlots>>>();
  for (const n of needs) slotsBySku.set(n.skuId, await lockReservableSlots(tx, warehouseId, n.skuId));
  const coversAll = needs.every(
    (n) => availableEligible(slotsBySku.get(n.skuId) ?? [], asOf, info.min_shelf_life_days) >= n.missing,
  );
  const reservedSkus: string[] = [];
  const units = { n: 0 };
  if (!info.all_or_nothing || coversAll) {
    for (const n of needs) {
      const allocs = await reserveLine(
        ctx,
        warehouseId,
        n,
        asOf,
        info.min_shelf_life_days,
        slotsBySku.get(n.skuId),
      );
      const q = allocs.reduce((s, a) => s + a.qty, 0);
      if (q > 0) reservedSkus.push(n.skuId);
      units.n += q;
    }
  }
  const after = await lines(tx, order.id);
  const full = after.every((l) => l.reserved_qty + l.picked_qty === l.qty);
  const target = full ? 'reserved' : 'awaiting_stock';
  const moved =
    order.status === target
      ? ok(order)
      : await transition(tx, ctx.fx, order, { to: target, actor: 'system', actorId: null, now });
  if (!moved.ok) return moved;
  if (full) {
    await tx.$executeRaw`UPDATE orders SET partial_reserve_expires_at = NULL WHERE id = ${order.id}::uuid`;
    await scheduleAction(tx, { kind: 'wave_check', key: warehouseId, dueAt: now });
    ctx.fx.actions.push({ kind: 'wave_check', key: warehouseId });
  } else if (units.n > 0 && !info.all_or_nothing && info.partial_reserve_expires_at === null) {
    const expires = new Date(now.getTime() + d.settings.partialReserveTtlMin * 60_000);
    await tx.$executeRaw`UPDATE orders SET partial_reserve_expires_at = ${expires} WHERE id = ${order.id}::uuid`;
    await scheduleAction(tx, { kind: 'partial_reserve_expiry', key: order.id, dueAt: expires });
  }
  await stockChanged(ctx, reservedSkus);
  return ok({ status: target, reservedUnits: units.n });
};

export const reserveOrder = (
  d: FloorDeps,
  outer: Effects,
  orderId: string,
): Promise<Result<ReserveOutcome>> =>
  runTx(d.db, outer, async (tx, fx) => {
    const order = await lockOrder(tx, orderId);
    if (order === null || (order.status !== 'received' && order.status !== 'awaiting_stock')) {
      return ok({ status: order?.status ?? 'missing', reservedUnits: 0 });
    }
    return reserveLocked(ctxOf(tx, fx, d, SYSTEM, 'order', orderId, d.clock.now()), d, order);
  });

/**
 * Fair re-reserve after stock arrived for (warehouse, SKU): waiting orders in priority order
 * (express, then arrival). One pass per (warehouse, SKU) at a time; no order gets stock twice
 * because reserve only fills what each line is still missing, under the order lock.
 */
export const rereserve = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  skuId: string,
): Promise<Result<{ readonly orders: number }>> =>
  runTx(d.db, outer, async (tx, fx) => {
    const now = d.clock.now();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rereserve:${warehouseId}:${skuId}`}, 0))`;
    const waiting = await tx.$queryRaw<{ id: string }[]>`
      SELECT o.id FROM orders o JOIN order_lines l ON l.order_id = o.id
      WHERE (o.warehouse_id = ${warehouseId}::uuid OR o.warehouse_id IS NULL) AND o.status = 'awaiting_stock' AND l.sku_id = ${skuId}::uuid
        AND l.qty > l.reserved_qty + l.picked_qty
      ORDER BY (o.delivery_method = 'express') DESC, o.received_at, o.id
      LIMIT 1000`;
    const touched = { n: 0 };
    for (const w of waiting) {
      const free = await tx.$queryRaw<{ n: number }[]>`
        SELECT COALESCE(SUM(b.on_hand - b.reserved), 0)::int AS n FROM stock_balances b JOIN locations l ON l.id = b.location_id
        WHERE b.warehouse_id = ${warehouseId}::uuid AND b.sku_id = ${skuId}::uuid AND l.kind = 'storage' AND l.blocked_reason IS NULL`;
      if ((free[0]?.n ?? 0) <= 0) break;
      const order = await lockOrder(tx, w.id);
      if (order === null || order.status !== 'awaiting_stock') continue;
      const r = await reserveLocked(
        ctxOf(tx, fx, d, SYSTEM, 'rereserve', `${warehouseId}:${skuId}`, now),
        d,
        order,
      );
      if (!r.ok) return r;
      if (r.value.reservedUnits > 0) touched.n += 1;
    }
    return ok({ orders: touched.n });
  });

/** Releases every reservation of a locked order; schedules re-reserve for the freed stock. */
export const releaseReservations = async (ctx: Ctx, orderId: string): Promise<readonly string[]> => {
  const rs = await lockOrderReservations(ctx.tx, orderId);
  for (const r of rs) await unreserve(ctx, r, r.qty);
  const byWh = new Map<string, string[]>();
  for (const r of rs) byWh.set(r.warehouseId, [...(byWh.get(r.warehouseId) ?? []), r.skuId]);
  for (const [wh, skus] of byWh) await scheduleRereserve(ctx, wh, skus);
  await stockChanged(
    ctx,
    rs.map((r) => r.skuId),
  );
  return rs.map((r) => r.skuId);
};

/** A partial reserve held too long is released; the order then waits for a full reserve. */
export const expirePartialReserve = (
  d: FloorDeps,
  outer: Effects,
  orderId: string,
): Promise<Result<{ readonly released: boolean }>> =>
  runTx<{ readonly released: boolean }>(d.db, outer, async (tx, fx) => {
    const now = d.clock.now();
    const order = await lockOrder(tx, orderId);
    if (order === null || order.status !== 'awaiting_stock') return ok({ released: false });
    const [o] = await tx.$queryRaw<{ partial_reserve_expires_at: Date | null }[]>`
      SELECT partial_reserve_expires_at FROM orders WHERE id = ${orderId}::uuid`;
    if (o?.partial_reserve_expires_at === null || o === undefined || o.partial_reserve_expires_at > now)
      return ok({ released: false });
    await releaseReservations(ctxOf(tx, fx, d, SYSTEM, 'reserve_expiry', orderId, now), orderId);
    await tx.$executeRaw`UPDATE orders SET all_or_nothing = true, partial_reserve_expires_at = NULL WHERE id = ${orderId}::uuid`;
    return ok({ released: true });
  });
