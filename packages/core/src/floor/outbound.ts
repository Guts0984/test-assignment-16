// Packing, shipping and cancellation (ASSIGNMENT "Packer", "Cancel", "Cutoff"; invariant 5).
// All three lock the order row first, so a cancel racing the last scan or packing has exactly one
// outcome: cancelled with every picked unit in the return cell, or packed and the cancel refused.
import { type Tx } from '@ff/db/client';
import { fail, ok, type Result } from '@ff/shared/result';
import { isCancellable } from '@ff/shared/rules/status';
import { localDateOf, shipDayFor } from '@ff/shared/time/calendar';
import { type Effects } from '../effects';
import { lockOrder, transition, type LockedOrder } from '../orders/transition';
import { runTx } from '../tx-result';
import { ctxOf, loadWarehouse, type Actor, type FloorDeps } from './context';
import { idempotent } from './idempotency';
import { transferStock, virtualLocation, writeMovements, type Ctx } from './ledger-ops';
import { releaseReservations } from './reserve';

/** Units of an order sitting in packing, per SKU and batch (everything picked so far). */
const pickedUnits = (tx: Tx, orderId: string) =>
  tx.$queryRaw<{ sku_id: string; batch_id: string; qty: number }[]>`
    SELECT pl.sku_id, pl.batch_id, SUM(pl.picked_qty)::int AS qty
    FROM pick_lines pl JOIN pick_tasks t ON t.id = pl.task_id
    WHERE t.order_id = ${orderId}::uuid AND pl.picked_qty > 0 GROUP BY pl.sku_id, pl.batch_id`;

export type PackResult = {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly shipDay: string;
  readonly packedAt: string;
};

const resolveOrder = async (tx: Tx, warehouseId: string, ref: string): Promise<string | null> => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  // A scanned order number may exist for several shops: prefer the one waiting for packing.
  const rows = isUuid
    ? await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM orders WHERE warehouse_id = ${warehouseId}::uuid AND id = ${ref}::uuid`
    : await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE warehouse_id = ${warehouseId}::uuid AND external_number = ${ref}
        ORDER BY (status = 'picked') DESC, received_at DESC LIMIT 1`;
  return rows[0]?.id ?? null;
};

/** The packer scans the order: ship day from the warehouse cutoff (server clock), label available. */
export const packOrder = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  packerId: string,
  actorRole: 'packer' | 'shift_lead',
  orderRef: string,
  key: string,
): Promise<Result<PackResult>> =>
  runTx<PackResult>(d.db, outer, (tx, fx) =>
    idempotent(tx, `pack:${packerId}`, key, { warehouseId, orderRef }, async () => {
      const now = d.clock.now();
      const id = await resolveOrder(tx, warehouseId, orderRef);
      if (id === null) return fail('NOT_FOUND', 'no such order at this warehouse');
      const order = await lockOrder(tx, id);
      if (order === null) return fail('NOT_FOUND', 'no such order at this warehouse');
      if (order.status === 'cancelled')
        return fail('ORDER_CANCELLED', 'the order was cancelled; take the goods to the return cell');
      if (order.status !== 'picked')
        return fail('INVALID_TRANSITION', `order is ${order.status}, it can be packed only when picked`);
      const wh = await loadWarehouse(tx, warehouseId);
      if (wh === null) return fail('NOT_FOUND', 'warehouse not found');
      const shipDay = shipDayFor(now, wh);
      await tx.$executeRaw`UPDATE orders SET packed_at = ${now}, ship_day = ${shipDay}::date WHERE id = ${id}::uuid`;
      const moved = await transition(tx, fx, order, {
        to: 'packed',
        actor: actorRole,
        actorId: packerId,
        now,
      });
      if (!moved.ok) return moved;
      return ok({ orderId: id, orderNumber: order.externalNumber, shipDay, packedAt: now.toISOString() });
    }),
  );

const shipLocked = async (
  ctx: Ctx,
  order: LockedOrder,
  warehouseId: string,
  actorRole: 'storekeeper' | 'shift_lead',
): Promise<Result<LockedOrder>> => {
  const packing = await virtualLocation(ctx.tx, warehouseId, 'packing');
  for (const u of await pickedUnits(ctx.tx, order.id)) {
    await writeMovements(ctx, [
      {
        kind: 'ship',
        warehouseId,
        locationId: packing,
        skuId: u.sku_id,
        batchId: u.batch_id,
        onHandDelta: -u.qty,
        reservedDelta: 0,
        qty: u.qty,
        from: packing,
        to: null,
      },
    ]);
  }
  await ctx.tx.$executeRaw`UPDATE orders SET shipped_at = ${ctx.now} WHERE id = ${order.id}::uuid`;
  return transition(ctx.tx, ctx.fx, order, {
    to: 'shipped',
    actor: actorRole,
    actorId: ctx.actorId,
    now: ctx.now,
  });
};

export type ShipResult = { readonly shipped: readonly string[]; readonly skipped: readonly string[] };

/** Hands packed orders to the carrier: the given ones, or all whose ship day has come. */
export const shipOrders = async (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  actorId: string,
  actorRole: 'storekeeper' | 'shift_lead',
  orderIds: readonly string[] | undefined,
): Promise<Result<ShipResult>> => {
  const wh = await loadWarehouse(d.db, warehouseId);
  if (wh === null) return fail('NOT_FOUND', 'warehouse not found');
  const today = localDateOf(d.clock.now(), wh.timeZone);
  const candidates =
    orderIds ??
    (
      await d.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE warehouse_id = ${warehouseId}::uuid AND status = 'packed' AND ship_day <= ${today}::date ORDER BY packed_at LIMIT 1000`
    ).map((r) => r.id);
  const shipped: string[] = [];
  const skipped: string[] = [];
  for (const id of candidates) {
    const r = await runTx<boolean>(d.db, outer, async (tx, fx) => {
      const order = await lockOrder(tx, id);
      if (order === null || order.warehouseId !== warehouseId || order.status !== 'packed') return ok(false);
      const moved = await shipLocked(
        ctxOf(tx, fx, d, { type: 'staff', id: actorId }, 'shipment', id, d.clock.now()),
        order,
        warehouseId,
        actorRole,
      );
      return moved.ok ? ok(true) : moved;
    });
    (r.ok && r.value ? shipped : skipped).push(id);
  }
  return ok({ shipped, skipped });
};

export type CancelResult = {
  readonly orderId: string;
  readonly status: 'cancelled';
  readonly returnedUnits: number;
  readonly alreadyCancelled: boolean;
};

/**
 * Cancel by the shop or an admin. Before picking: the reserve is released. During picking: the
 * picked units move from packing to the return cell (to be put away again). Packed or shipped:
 * refused (decision D-3).
 */
export const cancelOrder = (
  d: FloorDeps,
  outer: Effects,
  orderId: string,
  actor: Actor & { readonly role: 'shop' | 'admin' },
  shopScope: string | null,
): Promise<Result<CancelResult>> =>
  runTx<CancelResult>(d.db, outer, async (tx, fx) => {
    const now = d.clock.now();
    const order = await lockOrder(tx, orderId);
    if (order === null || (shopScope !== null && order.shopId !== shopScope))
      return fail('NOT_FOUND', 'order not found');
    if (order.status === 'cancelled')
      return ok({ orderId, status: 'cancelled', returnedUnits: 0, alreadyCancelled: true });
    if (!isCancellable(order.status))
      return fail('ORDER_NOT_CANCELLABLE', `an order that is ${order.status} cannot be cancelled`);
    const ctx = ctxOf(tx, fx, d, actor, 'cancel', orderId, now);
    await tx.$executeRaw`SELECT id FROM pick_tasks WHERE order_id = ${orderId}::uuid FOR UPDATE`;
    await releaseReservations(ctx, orderId);
    const units = order.warehouseId === null ? [] : await pickedUnits(tx, orderId);
    if (order.warehouseId !== null && units.length > 0) {
      const packing = await virtualLocation(tx, order.warehouseId, 'packing');
      const ret = await virtualLocation(tx, order.warehouseId, 'return');
      for (const u of units)
        await transferStock(ctx, 'return', {
          warehouseId: order.warehouseId,
          from: packing,
          to: ret,
          skuId: u.sku_id,
          batchId: u.batch_id,
          qty: u.qty,
        });
    }
    await tx.$executeRaw`UPDATE pick_tasks SET status = 'cancelled', completed_at = ${now} WHERE order_id = ${orderId}::uuid AND status IN ('pending', 'assigned')`;
    await tx.$executeRaw`UPDATE pick_lines SET status = 'cancelled' WHERE status = 'open' AND task_id IN (SELECT id FROM pick_tasks WHERE order_id = ${orderId}::uuid)`;
    await tx.$executeRaw`UPDATE wave_orders SET active = false WHERE order_id = ${orderId}::uuid AND active`;
    await tx.$executeRaw`UPDATE orders SET cancelled_at = ${now} WHERE id = ${orderId}::uuid`;
    const moved = await transition(tx, fx, order, {
      to: 'cancelled',
      actor: actor.role,
      actorId: actor.type === 'staff' ? actor.id : null,
      now,
    });
    if (!moved.ok) return moved;
    return ok({
      orderId,
      status: 'cancelled',
      returnedUnits: units.reduce((s, u) => s + u.qty, 0),
      alreadyCancelled: false,
    });
  });
