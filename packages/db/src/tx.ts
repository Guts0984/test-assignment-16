// Interactive transactions with a bounded retry on deadlock / serialization failure (CLAUDE.md data rules).
import { Prisma, type Db, type Tx } from './client';
import { isRetryable } from './pg-errors';

export type TxOptions = {
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly isolation?: Prisma.TransactionIsolationLevel;
};

const jitter = (attempt: number): number => Math.min(200, 10 * 2 ** attempt) * (0.5 + Math.random());
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const withTx = async <T>(db: Db, fn: (tx: Tx) => Promise<T>, o: TxOptions = {}): Promise<T> => {
  const retries = o.retries ?? 6;
  const run = async (attempt: number): Promise<T> => {
    try {
      return await db.$transaction(fn, {
        timeout: o.timeoutMs ?? 20_000,
        maxWait: 20_000,
        isolationLevel: o.isolation ?? Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    } catch (e) {
      if (attempt < retries && isRetryable(e)) {
        await pause(jitter(attempt));
        return run(attempt + 1);
      }
      throw e;
    }
  };
  return run(0);
};
