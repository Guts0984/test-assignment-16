// Live shift dashboard data (ASSIGNMENT shift lead 1): orders by status, waves, who picks what,
// orders at risk of missing the cutoff, counts waiting for approval. Time comes from the server clock.
import { type Db } from '@ff/db/client';
import { type OrderStatus } from '@ff/shared/domain';
import { isAtRisk, isLate, REMAINING_WORK_MIN } from '@ff/shared/rules/at-risk';
import { nextCutoff } from '@ff/shared/time/calendar';
import { loadWarehouse } from './context';

export const dashboard = async (
  db: Db,
  warehouseId: string,
  now: Date,
  bufferMin: number,
  online: ReadonlySet<string>,
) => {
  const wh = await loadWarehouse(db, warehouseId);
  if (wh === null) return null;
  const horizon = new Date(
    now.getTime() + (Math.max(...Object.values(REMAINING_WORK_MIN)) + bufferMin) * 60_000,
  );
  const [byStatus, waves, pickers, risky, counts] = await Promise.all([
    db.$queryRaw<{ status: OrderStatus; n: number }[]>`
      SELECT status, count(*)::int AS n FROM orders WHERE warehouse_id = ${warehouseId}::uuid AND status NOT IN ('shipped', 'cancelled') GROUP BY status`,
    db.$queryRaw<
      { id: string; trigger: string; created_at: Date; order_count: number; tasks: number; done: number }[]
    >`
      SELECT w.id, w.trigger, w.created_at, w.order_count, count(t.id)::int AS tasks, count(t.id) FILTER (WHERE t.status = 'done')::int AS done
      FROM waves w LEFT JOIN pick_tasks t ON t.wave_id = w.id
      WHERE w.warehouse_id = ${warehouseId}::uuid GROUP BY w.id ORDER BY w.created_at DESC LIMIT 10`,
    db.$queryRaw<
      {
        staff_id: string;
        name: string;
        task_id: string | null;
        order_number: string | null;
        lines: number;
        done: number;
      }[]
    >`
      SELECT s.id AS staff_id, s.name, t.id AS task_id, o.external_number AS order_number,
             count(pl.id)::int AS lines, count(pl.id) FILTER (WHERE pl.status <> 'open')::int AS done
      FROM staff s JOIN staff_roles r ON r.staff_id = s.id AND r.role = 'picker' AND r.warehouse_id = ${warehouseId}::uuid
      LEFT JOIN pick_tasks t ON t.assignee_id = s.id AND t.status = 'assigned' AND t.warehouse_id = ${warehouseId}::uuid
      LEFT JOIN orders o ON o.id = t.order_id
      LEFT JOIN pick_lines pl ON pl.task_id = t.id
      WHERE s.active GROUP BY s.id, s.name, t.id, o.external_number ORDER BY s.name`,
    db.$queryRaw<
      {
        id: string;
        external_number: string;
        status: OrderStatus;
        delivery_method: string;
        target_cutoff_at: Date | null;
      }[]
    >`
      SELECT id, external_number, status, delivery_method, target_cutoff_at FROM orders
      WHERE warehouse_id = ${warehouseId}::uuid AND status IN ('received', 'awaiting_stock', 'reserved', 'in_wave', 'picking', 'picked')
        AND target_cutoff_at < ${horizon} ORDER BY target_cutoff_at LIMIT 500`,
    db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_counts WHERE warehouse_id = ${warehouseId}::uuid AND status = 'pending_approval'`,
  ]);
  const cutoff = nextCutoff(now, wh);
  return {
    serverTime: now.toISOString(),
    warehouse: { id: wh.id, code: wh.code, timeZone: wh.timeZone },
    nextCutoff: { shipDay: cutoff.shipDay, at: cutoff.cutoffAt.toISOString(), msLeft: cutoff.msLeft },
    ordersByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Partial<
      Record<OrderStatus, number>
    >,
    waves: waves.map((w) => ({
      id: w.id,
      trigger: w.trigger,
      createdAt: w.created_at.toISOString(),
      orderCount: w.order_count,
      tasks: w.tasks,
      tasksDone: w.done,
    })),
    pickers: pickers.map((p) => ({
      staffId: p.staff_id,
      name: p.name,
      online: online.has(p.staff_id),
      taskId: p.task_id,
      orderNumber: p.order_number,
      lines: p.lines,
      linesDone: p.done,
    })),
    atRisk: risky
      .filter((o) => isAtRisk(o.status, o.target_cutoff_at, now, bufferMin))
      .map((o) => ({
        orderId: o.id,
        orderNumber: o.external_number,
        status: o.status,
        express: o.delivery_method === 'express',
        targetCutoffAt: o.target_cutoff_at?.toISOString() ?? null,
        late: isLate(o.status, o.target_cutoff_at, now),
      })),
    countsAwaitingApproval: counts[0]?.n ?? 0,
  };
};
