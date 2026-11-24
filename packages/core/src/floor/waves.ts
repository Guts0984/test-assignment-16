// Waves (ASSIGNMENT "Wave"): one formation per warehouse at a time, one wave per order.
import { type Tx } from '@ff/db/client';
import { ok, type Result } from '@ff/shared/result';
import { type Effects } from '../effects';
import { EVENTS, rooms } from '../realtime';
import { lockOrder, transition } from '../orders/transition';
import { runTx } from '../tx-result';
import { type FloorDeps } from './context';

export type WaveTriggerKind = 'timer' | 'threshold' | 'manual';
export type WaveOutcome = { readonly waveId: string | null; readonly orderCount: number };

const createTasks = async (
  tx: Tx,
  waveId: string,
  warehouseId: string,
  orderId: string,
  rank: number,
  now: Date,
): Promise<string> => {
  const [task] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO pick_tasks (wave_id, order_id, warehouse_id, status, priority_rank, created_at)
    VALUES (${waveId}::uuid, ${orderId}::uuid, ${warehouseId}::uuid, 'pending', ${rank}, ${now}) RETURNING id`;
  if (task === undefined) throw new Error('pick task insert returned nothing');
  await tx.$executeRaw`
    INSERT INTO pick_lines (task_id, order_line_id, location_id, sku_id, batch_id, qty, walk_order)
    SELECT ${task.id}::uuid, r.order_line_id, r.location_id, r.sku_id, r.batch_id, r.qty, l.walk_order
    FROM order_reservations r JOIN locations l ON l.id = r.location_id
    WHERE r.order_id = ${orderId}::uuid AND r.qty > 0`;
  return task.id;
};

/** Forms one wave from the warehouse's ready orders: nearest cutoff and express first. */
export const formWave = (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  trigger: WaveTriggerKind,
  actorId: string | null,
): Promise<Result<WaveOutcome>> =>
  runTx<WaveOutcome>(d.db, outer, async (tx, fx) => {
    const now = d.clock.now();
    // A manual wave and the timer (or two workers) never form waves concurrently.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wave:${warehouseId}`}, 0))`;
    const ready = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE warehouse_id = ${warehouseId}::uuid AND status = 'reserved'
      ORDER BY target_cutoff_at NULLS LAST, (delivery_method = 'express') DESC, received_at, id
      LIMIT ${d.settings.waveMaxOrders} FOR UPDATE SKIP LOCKED`;
    if (ready.length === 0) return ok({ waveId: null, orderCount: 0 });
    const [wave] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO waves (warehouse_id, trigger, created_by, order_count, created_at)
      VALUES (${warehouseId}::uuid, ${trigger}, ${actorId}::uuid, ${ready.length}, ${now}) RETURNING id`;
    if (wave === undefined) throw new Error('wave insert returned nothing');
    for (const [i, r] of ready.entries()) {
      const order = await lockOrder(tx, r.id);
      if (order === null || order.status !== 'reserved') continue;
      const moved = await transition(tx, fx, order, {
        to: 'in_wave',
        actor: trigger === 'manual' ? 'shift_lead' : 'system',
        actorId,
        now,
      });
      if (!moved.ok) return moved;
      await tx.$executeRaw`UPDATE wave_orders SET active = false WHERE order_id = ${r.id}::uuid AND active`;
      await tx.$executeRaw`INSERT INTO wave_orders (wave_id, order_id) VALUES (${wave.id}::uuid, ${r.id}::uuid)`;
      await createTasks(tx, wave.id, warehouseId, r.id, i + 1, now);
    }
    fx.realtime.push(
      {
        room: rooms.lead(warehouseId),
        event: EVENTS.waveFormed,
        payload: { waveId: wave.id, orderCount: ready.length, trigger },
      },
      { room: rooms.floor(warehouseId), event: EVENTS.taskChanged, payload: { waveId: wave.id } },
    );
    return ok({ waveId: wave.id, orderCount: ready.length });
  });

export const readyCount = async (d: FloorDeps, warehouseId: string): Promise<number> => {
  const [r] = await d.db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM orders WHERE warehouse_id = ${warehouseId}::uuid AND status = 'reserved'`;
  return r?.n ?? 0;
};

/** The 50-ready trigger: forms waves while at least `threshold` orders are ready. */
export const waveCheck = async (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
): Promise<Result<readonly WaveOutcome[]>> => {
  const formed: WaveOutcome[] = [];
  for (
    let guard = 0;
    guard < 20 && (await readyCount(d, warehouseId)) >= d.settings.waveReadyThreshold;
    guard += 1
  ) {
    const r = await formWave(d, outer, warehouseId, 'threshold', null);
    if (!r.ok) return r;
    if (r.value.waveId === null) break;
    formed.push(r.value);
  }
  return ok(formed);
};
