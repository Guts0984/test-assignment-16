// Moving reservations off a blocked cell (ASSIGNMENT "Shortage"; invariant 6): in the same
// transaction that blocks the cell, every reservation in it goes to another cell or batch of the
// same warehouse (FEFO, shelf life), its pick lines follow, or the order goes back to awaiting_stock.
import { ok, type Result } from '@ff/shared/result';
import { shipDayFor } from '@ff/shared/time/calendar';
import { lockOrder, transition } from '../orders/transition';
import { type FloorDeps, loadWarehouse } from './context';
import {
  lockCellReservations,
  reserveLine,
  scheduleRereserve,
  stockChanged,
  unreserve,
  type Ctx,
} from './ledger-ops';

/** Blocks a cell (count or shortage); caller holds the cell row lock. */
export const blockCell = async (
  ctx: Ctx,
  locationId: string,
  reason: 'count' | 'shortage',
): Promise<void> => {
  await ctx.tx
    .$executeRaw`UPDATE locations SET blocked_reason = COALESCE(blocked_reason, ${reason}) WHERE id = ${locationId}::uuid`;
};

/** Ends the live task of an order that went back to awaiting_stock (picked goods stay in packing). */
const parkOrder = async (ctx: Ctx, orderId: string): Promise<void> => {
  await ctx.tx
    .$executeRaw`UPDATE pick_tasks SET status = 'cancelled', completed_at = ${ctx.now} WHERE order_id = ${orderId}::uuid AND status IN ('pending', 'assigned')`;
  await ctx.tx
    .$executeRaw`UPDATE wave_orders SET active = false WHERE order_id = ${orderId}::uuid AND active`;
};

export const relocateCellReservations = async (
  ctx: Ctx,
  d: FloorDeps,
  warehouseId: string,
  locationId: string,
): Promise<Result<{ readonly moved: number; readonly parked: number }>> => {
  const wh = await loadWarehouse(ctx.tx, warehouseId);
  if (wh === null) return ok({ moved: 0, parked: 0 });
  const asOf = shipDayFor(ctx.now, wh);
  const stats = { moved: 0, parked: 0 };
  const rs = await lockCellReservations(ctx.tx, locationId);
  for (const r of rs) {
    const order = await lockOrder(ctx.tx, r.orderId);
    if (order === null) continue;
    const [shop] = await ctx.tx.$queryRaw<{ min: number }[]>`
      SELECT s.min_shelf_life_days AS min FROM shops s JOIN orders o ON o.shop_id = s.id WHERE o.id = ${r.orderId}::uuid`;
    await unreserve(ctx, r, r.qty);
    // Open pick lines for this reservation stop here; replacements are created below.
    const lines = await ctx.tx.$queryRaw<{ id: string; task_id: string; qty: number; picked_qty: number }[]>`
      SELECT pl.id, pl.task_id, pl.qty, pl.picked_qty FROM pick_lines pl JOIN pick_tasks t ON t.id = pl.task_id
      WHERE pl.order_line_id = ${r.orderLineId}::uuid AND pl.location_id = ${locationId}::uuid AND pl.batch_id = ${r.batchId}::uuid
        AND pl.status = 'open' AND t.status IN ('pending', 'assigned') FOR UPDATE OF pl`;
    for (const l of lines) {
      await ctx.tx.$executeRaw`UPDATE pick_lines SET status = 'short' WHERE id = ${l.id}::uuid`;
    }
    const allocs = await reserveLine(
      ctx,
      warehouseId,
      { orderId: r.orderId, lineId: r.orderLineId, skuId: r.skuId, missing: r.qty },
      asOf,
      shop?.min ?? 0,
    );
    const got = allocs.reduce((s, a) => s + a.qty, 0);
    const task = lines[0]?.task_id;
    if (task !== undefined) {
      for (const a of allocs) {
        await ctx.tx.$executeRaw`
          INSERT INTO pick_lines (task_id, order_line_id, location_id, sku_id, batch_id, qty, walk_order)
          SELECT ${task}::uuid, ${r.orderLineId}::uuid, ${a.cellId}::uuid, ${r.skuId}::uuid, ${a.batchId}::uuid, ${a.qty}, walk_order
          FROM locations WHERE id = ${a.cellId}::uuid`;
      }
    }
    if (got === r.qty) {
      stats.moved += 1;
      continue;
    }
    stats.parked += 1;
    if (order.status === 'reserved' || order.status === 'in_wave' || order.status === 'picking') {
      const moved = await transition(ctx.tx, ctx.fx, order, {
        to: 'awaiting_stock',
        actor: 'system',
        actorId: null,
        reason: 'stock in the cell is not available',
        now: ctx.now,
      });
      if (!moved.ok) return moved;
      await parkOrder(ctx, order.id);
    }
  }
  await scheduleRereserve(
    ctx,
    warehouseId,
    rs.map((r) => r.skuId),
  );
  await stockChanged(
    ctx,
    rs.map((r) => r.skuId),
  );
  return ok(stats);
};
