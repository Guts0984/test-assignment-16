// Side effects collected inside a transaction and performed only after it commits:
// realtime messages and fast-path BullMQ enqueues (the reconciler is the safety net).
import { type Db } from '@ff/db/client';
import { type Clock } from './clock';
import { type Queues } from './queues';
import { type Emitter, type RealtimeMessage } from './realtime';
import { jobIdFor, type ActionKind } from './scheduled-actions';

export type Effects = {
  readonly realtime: RealtimeMessage[];
  readonly actions: { readonly kind: ActionKind; readonly key: string }[];
};

export const newEffects = (): Effects => ({ realtime: [], actions: [] });

export type EffectDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly emitter: Emitter;
  readonly queues: Queues | null;
};

/** Best effort: failures here never undo committed work; the reconciler re-enqueues from Postgres. */
export const flushEffects = async (d: EffectDeps, fx: Effects): Promise<void> => {
  try {
    d.emitter.emit(fx.realtime);
  } catch {
    // realtime is best effort; clients refetch on reconnect
  }
  if (d.queues === null || fx.actions.length === 0) return;
  const now = d.clock.now();
  await Promise.all(
    fx.actions.map(async (a) => {
      try {
        const row = await d.db.scheduledAction.findUnique({ where: { kind_key: { kind: a.kind, key: a.key } } });
        if (row === null || row.status !== 'pending' || row.dueAt > now) return;
        await d.queues?.enqueue(a.kind, row.id, jobIdFor(row));
      } catch {
        // Redis down: the reconciler picks it up later
      }
    }),
  );
};
