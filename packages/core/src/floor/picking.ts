// Picking (ASSIGNMENT "Picker", "Picking"; invariants 4, 6, 7): take the next task, scan cell then
// product, one line is never picked twice, wrong cell / SKU / batch is refused.
import { type Tx } from '@ff/db/client';
import { fail, ok, type Result } from '@ff/shared/result';
import { sortRoute } from '@ff/shared/rules/putaway';
import { type ScanItemInput } from '@ff/shared/schemas/floor';
import { type Effects } from '../effects';
import { EVENTS, rooms } from '../realtime';
import { lockOrder, transition } from '../orders/transition';
import { runTx } from '../tx-result';
import { ctxOf, type FloorDeps } from './context';
import { idempotent } from './idempotency';
import { virtualLocation, writeMovements, type Ctx } from './ledger-ops';

export type TaskLineView = {
  readonly lineId: string;
  readonly cellCode: string;
  readonly walkOrder: number;
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly barcode: string;
  readonly batchCode: string;
  readonly tracksExpiry: boolean;
  readonly qty: number;
  readonly pickedQty: number;
  readonly status: string;
};
export type TaskView = {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly warehouseId: string;
  readonly status: string;
  readonly assigneeId: string | null;
  readonly lines: readonly TaskLineView[];
};

export const taskView = async (tx: Tx | FloorDeps['db'], taskId: string): Promise<TaskView | null> => {
  const [t] = await tx.$queryRaw<
    {
      id: string;
      order_id: string;
      external_number: string;
      warehouse_id: string;
      status: string;
      assignee_id: string | null;
    }[]
  >`
    SELECT t.id, t.order_id, o.external_number, t.warehouse_id, t.status, t.assignee_id
    FROM pick_tasks t JOIN orders o ON o.id = t.order_id WHERE t.id = ${taskId}::uuid`;
  if (t === undefined) return null;
  const lines = await tx.$queryRaw<
    {
      id: string;
      code: string;
      walk_order: number;
      sku_id: string;
      sku_code: string;
      name: string;
      barcode: string;
      batch_code: string;
      tracks_expiry: boolean;
      qty: number;
      picked_qty: number;
      status: string;
    }[]
  >`SELECT pl.id, l.code, pl.walk_order, pl.sku_id, s.code AS sku_code, s.name, s.barcode, b.code AS batch_code, s.tracks_expiry, pl.qty, pl.picked_qty, pl.status
    FROM pick_lines pl JOIN locations l ON l.id = pl.location_id JOIN skus s ON s.id = pl.sku_id JOIN batches b ON b.id = pl.batch_id
    WHERE pl.task_id = ${taskId}::uuid`;
  return {
    id: t.id,
    orderId: t.order_id,
    orderNumber: t.external_number,
    warehouseId: t.warehouse_id,
    status: t.status,
    assigneeId: t.assignee_id,
    lines: sortRoute(lines.map((l) => ({ ...l, cellCode: l.code, walkOrder: l.walk_order }))).map((l) => ({
      lineId: l.id,
      cellCode: l.cellCode,
      walkOrder: l.walkOrder,
      skuId: l.sku_id,
      skuCode: l.sku_code,
      skuName: l.name,
      barcode: l.barcode,
      batchCode: l.batch_code,
      tracksExpiry: l.tracks_expiry,
      qty: l.qty,
      pickedQty: l.picked_qty,
      status: l.status,
    })),
  };
};

/** The picker's current task, or the highest-priority pending one (SKIP LOCKED: never shared). */
export const takeNextTask = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  pickerId: string,
): Promise<Result<TaskView>> =>
  runTx<TaskView>(d.db, outer, async (tx, fx) => {
    const now = d.clock.now();
    const [mine] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM pick_tasks WHERE warehouse_id = ${warehouseId}::uuid AND assignee_id = ${pickerId}::uuid AND status = 'assigned'
      ORDER BY assigned_at LIMIT 1`;
    if (mine !== undefined) {
      const v = await taskView(tx, mine.id);
      return v === null ? fail('NOT_FOUND', 'task vanished') : ok(v);
    }
    const [next] = await tx.$queryRaw<{ id: string; order_id: string }[]>`
      SELECT t.id, t.order_id FROM pick_tasks t JOIN waves w ON w.id = t.wave_id
      WHERE t.warehouse_id = ${warehouseId}::uuid AND t.status = 'pending'
      ORDER BY w.created_at, t.priority_rank LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
    if (next === undefined) return fail('NO_TASK_AVAILABLE', 'no pick task is waiting');
    const order = await lockOrder(tx, next.order_id);
    if (order === null || order.status !== 'in_wave')
      return fail('CONFLICT', 'task order changed, take again');
    await tx.$executeRaw`UPDATE pick_tasks SET status = 'assigned', assignee_id = ${pickerId}::uuid, assigned_at = ${now} WHERE id = ${next.id}::uuid`;
    const moved = await transition(tx, fx, order, { to: 'picking', actor: 'picker', actorId: pickerId, now });
    if (!moved.ok) return moved;
    fx.realtime.push({
      room: rooms.lead(warehouseId),
      event: EVENTS.taskChanged,
      payload: { taskId: next.id, assigneeId: pickerId, status: 'assigned' },
    });
    const v = await taskView(tx, next.id);
    return v === null ? fail('NOT_FOUND', 'task vanished') : ok(v);
  });

type LockedLine = {
  id: string;
  task_id: string;
  order_line_id: string;
  location_id: string;
  sku_id: string;
  batch_id: string;
  qty: number;
  picked_qty: number;
  status: string;
};

/** Locks order -> task -> line -> cell in the global order and checks the picker owns the task. */
export const lockTaskLine = async (tx: Tx, taskId: string, lineId: string, pickerId: string | null) => {
  const [t0] = await tx.$queryRaw<
    { order_id: string }[]
  >`SELECT order_id FROM pick_tasks WHERE id = ${taskId}::uuid`;
  if (t0 === undefined) return fail('NOT_FOUND', 'task not found');
  const order = await lockOrder(tx, t0.order_id);
  if (order === null) return fail('NOT_FOUND', 'order not found');
  const [task] = await tx.$queryRaw<
    { id: string; status: string; assignee_id: string | null; warehouse_id: string }[]
  >`
    SELECT id, status, assignee_id, warehouse_id FROM pick_tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
  if (task === undefined) return fail('NOT_FOUND', 'task not found');
  if (order.status === 'cancelled')
    return fail('ORDER_CANCELLED', 'the order was cancelled; return the goods');
  if (task.status === 'done' && (pickerId === null || task.assignee_id === pickerId))
    return fail('LINE_COMPLETE', 'this task is already picked');
  if (task.status !== 'assigned' || (pickerId !== null && task.assignee_id !== pickerId)) {
    return fail('TASK_NOT_ASSIGNED', 'this task is not assigned to you');
  }
  const [line] = await tx.$queryRaw<LockedLine[]>`
    SELECT id, task_id, order_line_id, location_id, sku_id, batch_id, qty, picked_qty, status
    FROM pick_lines WHERE id = ${lineId}::uuid AND task_id = ${taskId}::uuid FOR UPDATE`;
  if (line === undefined) return fail('NOT_FOUND', 'task line not found');
  const [cell] = await tx.$queryRaw<{ code: string; blocked_reason: string | null }[]>`
    SELECT code, blocked_reason FROM locations WHERE id = ${line.location_id}::uuid FOR SHARE`;
  if (cell === undefined) return fail('NOT_FOUND', 'cell not found');
  return ok({ order, task, line, cell });
};

/** Picks `qty` from the line's cell into packing: ledger, reservation, order line, pick line. */
export const pickUnits = async (
  ctx: Ctx,
  warehouseId: string,
  line: LockedLine,
  qty: number,
): Promise<void> => {
  const packing = await virtualLocation(ctx.tx, warehouseId, 'packing');
  await writeMovements(ctx, [
    {
      kind: 'pick',
      warehouseId,
      locationId: line.location_id,
      skuId: line.sku_id,
      batchId: line.batch_id,
      onHandDelta: -qty,
      reservedDelta: -qty,
      qty,
      from: line.location_id,
      to: packing,
    },
    {
      kind: 'pick',
      warehouseId,
      locationId: packing,
      skuId: line.sku_id,
      batchId: line.batch_id,
      onHandDelta: qty,
      reservedDelta: 0,
      qty,
      from: line.location_id,
      to: packing,
    },
  ]);
  const n = await ctx.tx.$executeRaw`
    UPDATE order_reservations SET qty = qty - ${qty}
    WHERE order_line_id = ${line.order_line_id}::uuid AND location_id = ${line.location_id}::uuid AND batch_id = ${line.batch_id}::uuid AND qty >= ${qty}`;
  if (n !== 1) throw new Error('pick without a matching reservation');
  await ctx.tx
    .$executeRaw`DELETE FROM order_reservations WHERE order_line_id = ${line.order_line_id}::uuid AND qty = 0`;
  await ctx.tx
    .$executeRaw`UPDATE order_lines SET reserved_qty = reserved_qty - ${qty}, picked_qty = picked_qty + ${qty} WHERE id = ${line.order_line_id}::uuid`;
  // The CHECK (picked_qty <= qty) is the last line of defence against a double pick.
  await ctx.tx.$executeRaw`
    UPDATE pick_lines SET picked_qty = picked_qty + ${qty}, status = CASE WHEN picked_qty + ${qty} >= qty THEN 'done' ELSE status END
    WHERE id = ${line.id}::uuid`;
};

/** After a change, a task with no open line is done and its order becomes picked. */
export const completeTaskIfDone = async (
  ctx: Ctx,
  taskId: string,
  order: Parameters<typeof transition>[2],
  pickerId: string | null,
) => {
  const [open] = await ctx.tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pick_lines WHERE task_id = ${taskId}::uuid AND status = 'open'`;
  if ((open?.n ?? 0) > 0 || order.status !== 'picking') return ok(order);
  const [rest] = await ctx.tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM order_lines WHERE order_id = ${order.id}::uuid AND picked_qty < qty`;
  await ctx.tx
    .$executeRaw`UPDATE pick_tasks SET status = 'done', completed_at = ${ctx.now} WHERE id = ${taskId}::uuid`;
  if ((rest?.n ?? 0) > 0) return ok(order);
  return transition(ctx.tx, ctx.fx, order, {
    to: 'picked',
    actor: 'picker',
    actorId: pickerId,
    now: ctx.now,
  });
};

export type ScanResult = {
  readonly lineId: string;
  readonly pickedQty: number;
  readonly lineDone: boolean;
  readonly taskDone: boolean;
  readonly orderStatus: string;
};

export const scanItem = (
  d: FloorDeps,
  outer: Effects,
  taskId: string,
  pickerId: string,
  input: ScanItemInput,
): Promise<Result<ScanResult>> =>
  runTx<ScanResult>(d.db, outer, (tx, fx) =>
    idempotent(tx, `scan:${pickerId}`, input.idempotencyKey, { taskId, ...input }, async () => {
      const now = d.clock.now();
      const locked = await lockTaskLine(tx, taskId, input.lineId, pickerId);
      if (!locked.ok) return locked;
      const { order, task, line, cell } = locked.value;
      if (cell.code !== input.cellCode)
        return fail('WRONG_CELL', `this item is in cell ${cell.code}`, { expectedCell: cell.code });
      if (cell.blocked_reason !== null)
        return fail('CELL_BLOCKED', 'the cell is closed for picking (stock count)');
      const [sku] = await tx.$queryRaw<
        { barcode: string; tracks_expiry: boolean }[]
      >`SELECT barcode, tracks_expiry FROM skus WHERE id = ${line.sku_id}::uuid`;
      if (sku === undefined || sku.barcode !== input.barcode)
        return fail('WRONG_SKU', 'this is not the item of this line');
      const [batch] = await tx.$queryRaw<
        { code: string }[]
      >`SELECT code FROM batches WHERE id = ${line.batch_id}::uuid`;
      if (sku.tracks_expiry && (input.batchCode === undefined || input.batchCode !== batch?.code)) {
        return fail('WRONG_BATCH', `pick batch ${batch?.code ?? '?'}`, {
          expectedBatch: batch?.code ?? null,
        });
      }
      if (line.status !== 'open' || line.picked_qty >= line.qty)
        return fail('LINE_COMPLETE', 'this line is already picked');
      if (input.qty > line.qty - line.picked_qty)
        return fail('ALREADY_SCANNED', 'more units than the line still needs');
      const ctx = ctxOf(tx, fx, d, { type: 'staff', id: pickerId }, 'pick_task', taskId, now);
      await tx.$executeRaw`
        INSERT INTO pick_scans (idempotency_key, line_id, picker_id, qty, created_at)
        VALUES (${`${pickerId}:${input.idempotencyKey}`}, ${line.id}::uuid, ${pickerId}::uuid, ${input.qty}, ${now})`;
      await pickUnits(ctx, task.warehouse_id, line, input.qty);
      const done = await completeTaskIfDone(ctx, taskId, order, pickerId);
      if (!done.ok) return done;
      const picked = line.picked_qty + input.qty;
      fx.realtime.push({
        room: rooms.lead(task.warehouse_id),
        event: EVENTS.scan,
        payload: {
          taskId,
          lineId: line.id,
          orderId: order.id,
          pickerId,
          pickedQty: picked,
          qty: line.qty,
          at: now.toISOString(),
        },
      });
      return ok({
        lineId: line.id,
        pickedQty: picked,
        lineDone: picked >= line.qty,
        taskDone: done.value.status === 'picked',
        orderStatus: done.value.status,
      });
    }),
  );

/** "Scan the cell first": tells the picker whether the cell is the right one before the item scan. */
export const scanCell = async (
  d: FloorDeps,
  taskId: string,
  pickerId: string,
  cellCode: string,
): Promise<Result<{ readonly lines: readonly TaskLineView[] }>> => {
  const v = await taskView(d.db, taskId);
  if (v === null || v.assigneeId !== pickerId)
    return fail('TASK_NOT_ASSIGNED', 'this task is not assigned to you');
  const here = v.lines.filter((l) => l.cellCode === cellCode && l.status === 'open');
  if (here.length === 0) {
    const next = v.lines.find((l) => l.status === 'open');
    return fail('WRONG_CELL', next === undefined ? 'nothing left to pick' : `go to cell ${next.cellCode}`, {
      expectedCell: next?.cellCode ?? null,
    });
  }
  const [cell] = await d.db.$queryRaw<{ blocked_reason: string | null }[]>`
    SELECT blocked_reason FROM locations WHERE warehouse_id = ${v.warehouseId}::uuid AND code = ${cellCode}`;
  if (cell?.blocked_reason !== null && cell !== undefined)
    return fail('CELL_BLOCKED', 'the cell is closed for picking (stock count)');
  return ok({ lines: here });
};

export const reassignTask = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  taskId: string,
  pickerId: string,
  leadId: string,
): Promise<Result<TaskView>> =>
  runTx<TaskView>(d.db, outer, async (tx, fx) => {
    const now = d.clock.now();
    const [picker] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM staff s JOIN staff_roles r ON r.staff_id = s.id
      WHERE s.id = ${pickerId}::uuid AND s.active AND r.role = 'picker' AND r.warehouse_id = ${warehouseId}::uuid`;
    if ((picker?.n ?? 0) === 0)
      return fail('VALIDATION_FAILED', 'the new assignee is not a picker at this warehouse');
    const [t0] = await tx.$queryRaw<
      { order_id: string }[]
    >`SELECT order_id FROM pick_tasks WHERE id = ${taskId}::uuid AND warehouse_id = ${warehouseId}::uuid`;
    if (t0 === undefined) return fail('NOT_FOUND', 'task not found');
    const order = await lockOrder(tx, t0.order_id);
    const [task] = await tx.$queryRaw<
      { status: string; assignee_id: string | null }[]
    >`SELECT status, assignee_id FROM pick_tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
    if (order === null || task === undefined || (task.status !== 'pending' && task.status !== 'assigned')) {
      return fail('CONFLICT', 'the task is no longer open');
    }
    await tx.$executeRaw`UPDATE pick_tasks SET status = 'assigned', assignee_id = ${pickerId}::uuid, assigned_at = ${now} WHERE id = ${taskId}::uuid`;
    if (order.status === 'in_wave') {
      const moved = await transition(tx, fx, order, {
        to: 'picking',
        actor: 'shift_lead',
        actorId: leadId,
        now,
      });
      if (!moved.ok) return moved;
    }
    for (const who of [task.assignee_id, pickerId]) {
      if (who !== null)
        fx.realtime.push({
          room: rooms.picker(who),
          event: EVENTS.taskChanged,
          payload: { taskId, assigneeId: pickerId },
        });
    }
    fx.realtime.push({
      room: rooms.lead(warehouseId),
      event: EVENTS.taskChanged,
      payload: { taskId, assigneeId: pickerId, status: 'assigned' },
    });
    const v = await taskView(tx, taskId);
    return v === null ? fail('NOT_FOUND', 'task vanished') : ok(v);
  });
