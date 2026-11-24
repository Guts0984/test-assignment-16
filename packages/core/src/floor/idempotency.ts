// Idempotency keys for floor actions (double press, resend after a dropped connection): the key is
// claimed inside the same transaction as the work, so the effect happens exactly once and repeats
// get the original answer. A failed attempt does not burn the key (its transaction rolls back).
import { createHash } from 'node:crypto';
import { type Tx } from '@ff/db/client';
import { fail, ok, type Result } from '@ff/shared/result';
import { stableStringify } from '../orders/import';

export const requestHash = (v: unknown): string =>
  createHash('sha256').update(stableStringify(v)).digest('hex');

export const idempotent = async <T>(
  tx: Tx,
  scope: string,
  key: string,
  request: unknown,
  work: () => Promise<Result<T>>,
): Promise<Result<T>> => {
  const hash = requestHash(request);
  // Waits for a concurrent holder of the same key to commit or roll back.
  const claimed = await tx.$queryRaw<{ key: string }[]>`
    INSERT INTO idempotency_records (scope, key, request_hash, response) VALUES (${scope}, ${key}, ${hash}, 'null'::jsonb)
    ON CONFLICT (scope, key) DO NOTHING RETURNING key`;
  if (claimed.length === 0) {
    const [prev] = await tx.$queryRaw<{ request_hash: string; response: T }[]>`
      SELECT request_hash, response FROM idempotency_records WHERE scope = ${scope} AND key = ${key}`;
    if (prev === undefined) return fail('CONFLICT', 'idempotency key in flux, retry');
    if (prev.request_hash !== hash)
      return fail('IDEMPOTENCY_MISMATCH', 'this idempotency key was used for a different request');
    return ok(prev.response);
  }
  const r = await work();
  if (r.ok) {
    await tx.$executeRaw`UPDATE idempotency_records SET response = ${JSON.stringify(r.value ?? null)}::jsonb WHERE scope = ${scope} AND key = ${key}`;
  }
  return r;
};
