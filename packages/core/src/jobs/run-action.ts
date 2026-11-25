// Runs one scheduled action exactly once in effect: claim with a lease (only one worker wins),
// run an idempotent handler, finish (or record the failure with backoff; dead after N attempts).
import { withTx } from '@ff/db/tx';
import { backoffMs } from '@ff/shared/rules/webhook';
import { flushEffects, newEffects, type Effects } from '../effects';
import { type FloorDeps } from '../floor/context';
import { type Queues } from '../queues';
import { type Emitter } from '../realtime';
import {
  claimAction,
  dueActions,
  failClaim,
  finishClaim,
  type ActionKind,
  type ActionRow,
} from '../scheduled-actions';

export type RetryPolicy = {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
};
export type JobSettings = RetryPolicy & {
  readonly leaseMs: number;
  /** Per-kind overrides (webhooks retry longer than internal jobs). */
  readonly byKind?: Partial<Record<ActionKind, RetryPolicy>>;
};

export type Handler = (row: ActionRow, fx: Effects) => Promise<{ readonly next: Date | null }>;

export type JobDeps = FloorDeps & {
  readonly emitter: Emitter;
  readonly queues: Queues | null;
  readonly jobs: JobSettings;
  readonly handlers: Partial<Record<ActionKind, Handler>>;
};

export type RunOutcome = 'done' | 'skipped' | 'retry' | 'dead';

export const processAction = async (d: JobDeps, actionId: string, workerId: string): Promise<RunOutcome> => {
  const claim = await claimAction(d.db, actionId, workerId, d.clock.now(), d.jobs.leaseMs);
  if (claim === null) return 'skipped';
  const handler = d.handlers[claim.row.kind];
  const fx = newEffects();
  try {
    if (handler === undefined) throw new Error(`no handler for ${claim.row.kind}`);
    const { next } = await handler(claim.row, fx);
    const finished = await withTx(d.db, (tx) =>
      finishClaim(tx, claim, next === null ? null : { dueAt: next }),
    );
    await flushEffects(d, fx);
    return finished ? 'done' : 'skipped';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const policy = d.jobs.byKind?.[claim.row.kind] ?? d.jobs;
    // A handler may report which attempt of ITS unit of work failed (a webhook event): the budget then
    // belongs to that event, so earlier failures of other events in the stream cannot use it up.
    const reported = (e as { eventAttempts?: unknown } | null)?.eventAttempts;
    const attemptNo = typeof reported === 'number' ? reported : claim.row.attempts + 1;
    const outcome = await failClaim(
      d.db,
      claim,
      message,
      d.clock.now(),
      policy.maxAttempts,
      backoffMs(attemptNo, policy.backoffBaseMs, policy.backoffMaxMs),
      attemptNo,
    );
    // A stream that ran out of attempts keeps its undelivered events marked dead until an admin reruns it.
    if (outcome === 'dead' && claim.row.kind === 'webhook_stream') {
      const [shopId = '', ...rest] = claim.row.key.split('|');
      await d.db
        .$executeRaw`UPDATE webhook_events SET status = 'dead' WHERE shop_id = ${shopId}::uuid AND stream = ${rest.join('|')} AND status IN ('pending', 'delivering')`;
    }
    return outcome;
  }
};

/** Processes every due action in-process until none is left (tests and catch-up). */
export const drainDue = async (
  d: JobDeps,
  workerId: string,
  kinds?: readonly ActionKind[],
  maxRounds = 50,
): Promise<number> => {
  const total = { n: 0 };
  for (let round = 0; round < maxRounds; round += 1) {
    const due = await dueActions(d.db, d.clock.now(), 500, kinds);
    if (due.length === 0) break;
    for (const r of due) if ((await processAction(d, r.id, workerId)) === 'done') total.n += 1;
  }
  return total.n;
};
