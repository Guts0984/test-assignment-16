// "Not enough in the cell" (ASSIGNMENT "Shortage"; invariant 6): picks what was found, records the
// shortage, blocks the cell for a stock count and moves every reservation away, in one transaction.
import { fail, ok, type Result } from '@ff/shared/result';
import { type Effects } from '../effects';
import { EVENTS, rooms } from '../realtime';
import { runTx } from '../tx-result';
import { ctxOf, type FloorDeps } from './context';
import { idempotent } from './idempotency';
import { completeTaskIfDone, lockTaskLine, pickUnits, taskView, type TaskView } from './picking';
import { blockCell, relocateCellReservations } from './relocate';

export const reportShortage = (
  d: FloorDeps,
  outer: Effects,
  taskId: string,
  pickerId: string,
  input: { readonly lineId: string; readonly foundQty: number; readonly idempotencyKey: string },
): Promise<Result<TaskView>> =>
  runTx<TaskView>(d.db, outer, (tx, fx) =>
    idempotent(tx, `shortage:${pickerId}`, input.idempotencyKey, { taskId, ...input }, async () => {
      const now = d.clock.now();
      const locked = await lockTaskLine(tx, taskId, input.lineId, pickerId);
      if (!locked.ok) return locked;
      const { order, task, line } = locked.value;
      // Upgrade to an exclusive cell lock: scans and reserves on this cell wait for us.
      await tx.$executeRaw`SELECT id FROM locations WHERE id = ${line.location_id}::uuid FOR UPDATE`;
      const remaining = line.qty - line.picked_qty;
      if (line.status !== 'open' || remaining <= 0)
        return fail('LINE_COMPLETE', 'this line is already picked');
      if (input.foundQty >= remaining)
        return fail('VALIDATION_FAILED', 'found quantity covers the line; scan the items instead');
      const ctx = ctxOf(tx, fx, d, { type: 'staff', id: pickerId }, 'shortage', taskId, now);
      if (input.foundQty > 0) await pickUnits(ctx, task.warehouse_id, line, input.foundQty);
      await tx.$executeRaw`
        INSERT INTO shortages (warehouse_id, task_id, line_id, location_id, sku_id, batch_id, picker_id, expected_qty, found_qty, created_at)
        VALUES (${task.warehouse_id}::uuid, ${taskId}::uuid, ${line.id}::uuid, ${line.location_id}::uuid, ${line.sku_id}::uuid,
                ${line.batch_id}::uuid, ${pickerId}::uuid, ${remaining}, ${input.foundQty}, ${now})`;
      await blockCell(ctx, line.location_id, 'shortage');
      await tx.$executeRaw`
        INSERT INTO stock_counts (warehouse_id, location_id, status, origin, created_at)
        VALUES (${task.warehouse_id}::uuid, ${line.location_id}::uuid, 'open', 'shortage', ${now})
        ON CONFLICT (location_id) WHERE status <> 'closed' DO NOTHING`;
      const rel = await relocateCellReservations(ctx, d, task.warehouse_id, line.location_id);
      if (!rel.ok) return rel;
      const [fresh] = await tx.$queryRaw<
        { status: string; status_version: number }[]
      >`SELECT status, status_version FROM orders WHERE id = ${order.id}::uuid`;
      if (fresh?.status === 'picking') {
        const done = await completeTaskIfDone(
          ctx,
          taskId,
          { ...order, status: 'picking', statusVersion: fresh.status_version },
          pickerId,
        );
        if (!done.ok) return done;
      }
      fx.realtime.push({
        room: rooms.lead(task.warehouse_id),
        event: EVENTS.shortage,
        payload: {
          taskId,
          lineId: line.id,
          locationId: line.location_id,
          pickerId,
          expected: remaining,
          found: input.foundQty,
          at: now.toISOString(),
        },
      });
      const v = await taskView(tx, taskId);
      return v === null ? fail('NOT_FOUND', 'task vanished') : ok(v);
    }),
  );
