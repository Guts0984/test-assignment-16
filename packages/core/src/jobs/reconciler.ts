// The reconciler turns Postgres into BullMQ jobs (plan.md A-28). BullMQ is only a fast path: after
// a Redis wipe the next tick rebuilds every due job from scheduled_actions, with deterministic job
// ids so nothing is queued twice, and handlers are idempotent so nothing runs twice.
import { type Queues } from '../queues';
import { dueActions, jobIdFor } from '../scheduled-actions';
import { ensureWarehouseTimers } from './maintenance';
import { type FloorDeps } from '../floor/context';

export type ReconcileDeps = FloorDeps & { readonly queues: Queues; readonly nightlyLocalTime: string };

export const reconcileOnce = async (d: ReconcileDeps): Promise<number> => {
  await ensureWarehouseTimers(d);
  const due = await dueActions(d.db, d.clock.now(), 1000);
  await Promise.all(
    due.map((row) =>
      d.queues.enqueue(row.kind, row.id, jobIdFor(row)).catch(() => {
        // Redis is down: the next tick retries; Postgres still holds the work.
      }),
    ),
  );
  return due.length;
};
