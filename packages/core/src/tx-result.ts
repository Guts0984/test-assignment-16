// Transactions that return Results: an error result rolls the whole transaction back, and
// effects are kept only from the attempt that committed (deadlock retries start clean).
import { type Db, type Tx } from '@ff/db/client';
import { withTx } from '@ff/db/tx';
import { err, type DomainError, type Result } from '@ff/shared/result';
import { newEffects, type Effects } from './effects';

const ABORT = Symbol('abort-tx');
type Abort = { readonly [ABORT]: true; readonly error: DomainError };
const isAbort = (e: unknown): e is Abort => typeof e === 'object' && e !== null && ABORT in e;

export const runTx = async <T>(
  db: Db,
  outer: Effects,
  fn: (tx: Tx, fx: Effects) => Promise<Result<T>>,
): Promise<Result<T>> => {
  try {
    const { value, fx } = await withTx(db, async (tx) => {
      const fx = newEffects();
      const r = await fn(tx, fx);
      if (!r.ok) throw { [ABORT]: true, error: r.error } satisfies Abort;
      return { value: r.value, fx };
    });
    outer.realtime.push(...fx.realtime);
    outer.actions.push(...fx.actions);
    return { ok: true, value };
  } catch (e) {
    if (isAbort(e)) return err(e.error);
    throw e;
  }
};
