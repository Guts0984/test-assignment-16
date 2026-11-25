// Every pending background action is a row in Postgres (scheduled_actions). BullMQ only carries
// copies of due rows; after a Redis loss the reconciler rebuilds them (plan.md A-28).
import { Prisma, type Db, type Tx } from '@ff/db/client';

export const ACTION_KINDS = [
  'reserve_order',
  'rereserve',
  'wave_timer',
  'wave_check',
  'partial_reserve_expiry',
  'nightly',
  'webhook_stream',
  'import_batch',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

type JsonValue = Prisma.JsonValue;

export type ActionRow = {
  readonly id: string;
  readonly kind: ActionKind;
  readonly key: string;
  readonly dueAt: Date;
  readonly status: 'pending' | 'running' | 'done' | 'dead';
  readonly attempts: number;
  readonly runCount: number;
  readonly payload: JsonValue;
};

type RawRow = {
  id: string;
  kind: ActionKind;
  key: string;
  due_at: Date;
  status: ActionRow['status'];
  attempts: number;
  run_count: number;
  payload: Prisma.JsonValue;
};
const toRow = (r: RawRow): ActionRow => ({
  id: r.id,
  kind: r.kind,
  key: r.key,
  dueAt: r.due_at,
  status: r.status,
  attempts: r.attempts,
  runCount: r.run_count,
  payload: r.payload,
});

/**
 * Schedules (kind, key) at dueAt. A pending row keeps the earlier due time; a done or dead row is
 * re-armed. A running row is flagged `rearmed` and goes back to pending when its run finishes.
 */
export const scheduleAction = async (
  tx: Tx | Db,
  a: {
    readonly kind: ActionKind;
    readonly key: string;
    readonly dueAt: Date;
    readonly payload?: Prisma.InputJsonValue;
  },
): Promise<void> => {
  await tx.$executeRaw`
    INSERT INTO scheduled_actions (kind, key, due_at, status, payload, attempts, updated_at)
    VALUES (${a.kind}, ${a.key}, ${a.dueAt}, 'pending', ${JSON.stringify(a.payload ?? {})}::jsonb, 0, now())
    ON CONFLICT (kind, key) DO UPDATE SET
      due_at = CASE WHEN scheduled_actions.status = 'pending' THEN LEAST(scheduled_actions.due_at, EXCLUDED.due_at)
                    ELSE EXCLUDED.due_at END,
      status = CASE WHEN scheduled_actions.status = 'running' THEN 'running' ELSE 'pending' END,
      rearmed = scheduled_actions.status = 'running',
      attempts = CASE WHEN scheduled_actions.status IN ('done', 'dead') THEN 0 ELSE scheduled_actions.attempts END,
      payload = EXCLUDED.payload,
      updated_at = now()`;
};

/** Due pending rows, and running rows whose lease expired (their worker died). */
export const dueActions = async (
  db: Db,
  now: Date,
  limit: number,
  kinds?: readonly ActionKind[],
): Promise<readonly ActionRow[]> => {
  const kindFilter = kinds === undefined ? Prisma.empty : Prisma.sql`AND kind = ANY(${[...kinds]}::text[])`;
  const rows = await db.$queryRaw<RawRow[]>`
    SELECT id, kind, key, due_at, status, attempts, run_count, payload FROM scheduled_actions
    WHERE ((status = 'pending' AND due_at <= ${now}) OR (status = 'running' AND lease_until < ${now})) ${kindFilter}
    ORDER BY due_at LIMIT ${limit}`;
  return rows.map(toRow);
};

export type Claim = { readonly id: string; readonly runCount: number; readonly row: ActionRow };

/**
 * Claims a due row for one worker with a lease. Returns null when another worker holds it,
 * it is not due, or it is already done. Safe to call from any number of workers at once.
 */
export const claimAction = async (
  db: Db,
  id: string,
  workerId: string,
  now: Date,
  leaseMs: number,
): Promise<Claim | null> => {
  const rows = await db.$queryRaw<RawRow[]>`
    UPDATE scheduled_actions SET status = 'running', locked_by = ${workerId},
           lease_until = ${new Date(now.getTime() + leaseMs)}, run_count = run_count + 1, updated_at = now()
    WHERE id = ${id}::uuid
      AND ((status = 'pending' AND due_at <= ${now}) OR (status = 'running' AND lease_until < ${now}))
    RETURNING id, kind, key, due_at, status, attempts, run_count, payload`;
  const r = rows[0];
  return r === undefined ? null : { id: r.id, runCount: r.run_count, row: toRow(r) };
};

/**
 * Marks the claim done inside the effect's transaction. The row lock taken here serialises a
 * concurrent re-claim; if the claim was lost (lease expired and someone else took over) it
 * returns false and the caller must roll back its effect.
 */
export const finishClaim = async (
  tx: Tx,
  claim: Claim,
  next: { readonly dueAt: Date } | null,
): Promise<boolean> => {
  const n = await tx.$executeRaw`
    UPDATE scheduled_actions SET
      status = CASE WHEN ${next !== null} OR rearmed THEN 'pending' ELSE 'done' END,
      due_at = CASE WHEN rearmed THEN LEAST(due_at, ${next?.dueAt ?? claim.row.dueAt})
                    WHEN ${next !== null} THEN ${next?.dueAt ?? claim.row.dueAt} ELSE due_at END,
      rearmed = false,
      attempts = 0, last_error = NULL, lease_until = NULL, locked_by = NULL,
      completed_at = now(), updated_at = now()
    WHERE id = ${claim.id}::uuid AND status = 'running' AND run_count = ${claim.runCount}`;
  return n === 1;
};

/** Records a failed run. After maxAttempts the row is dead: visible to admins, rerunnable by hand. */
export const failClaim = async (
  db: Db,
  claim: Claim,
  error: string,
  now: Date,
  maxAttempts: number,
  backoffMs: number,
  /** The attempt number to record; defaults to one more than the row had (a run-level failure). */
  attemptNo?: number,
): Promise<'retry' | 'dead'> => {
  const rows = await db.$queryRaw<{ status: string }[]>`
    UPDATE scheduled_actions SET
      attempts = COALESCE(${attemptNo ?? null}::int, attempts + 1),
      status = CASE WHEN COALESCE(${attemptNo ?? null}::int, attempts + 1) >= ${maxAttempts} THEN 'dead' ELSE 'pending' END,
      due_at = ${new Date(now.getTime() + backoffMs)},
      last_error = left(${error}, 2000), lease_until = NULL, locked_by = NULL, updated_at = now()
    WHERE id = ${claim.id}::uuid AND status = 'running' AND run_count = ${claim.runCount}
    RETURNING status`;
  return rows[0]?.status === 'dead' ? 'dead' : 'retry';
};

export const deadActions = async (db: Db, limit: number) =>
  db.scheduledAction.findMany({ where: { status: 'dead' }, orderBy: { updatedAt: 'desc' }, take: limit });

/** Manual rerun of a dead action: exactly once, even when two admins click at the same time. */
export const rerunDeadAction = async (db: Db, id: string, now: Date): Promise<boolean> => {
  const n = await db.$executeRaw`
    UPDATE scheduled_actions SET status = 'pending', attempts = 0, due_at = ${now}, last_error = NULL, updated_at = now()
    WHERE id = ${id}::uuid AND status = 'dead'`;
  return n === 1;
};

/** Deterministic BullMQ job id for one run of a row (BullMQ ids may not contain ':'). */
export const jobIdFor = (row: Pick<ActionRow, 'id' | 'runCount' | 'dueAt'>): string =>
  `${row.id}_${row.runCount}_${row.dueAt.getTime()}`;
