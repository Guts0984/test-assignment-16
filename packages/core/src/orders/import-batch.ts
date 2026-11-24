// Batch import through the order-import queue: the batch is stored, then a worker imports each
// order with the same idempotent path as single imports.
import { type Db } from '@ff/db/client';
import { withTx } from '@ff/db/tx';
import { batchImportSchema, type BatchImportInput } from '@ff/shared/schemas/orders';
import { type Clock } from '../clock';
import { type Effects } from '../effects';
import { scheduleAction } from '../scheduled-actions';
import { importOrder } from './import';

export const createImportBatch = async (
  d: { readonly db: Db; readonly clock: Clock },
  fx: Effects,
  shopId: string,
  input: BatchImportInput,
): Promise<{ readonly batchId: string }> =>
  withTx(d.db, async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO import_batches (shop_id, status, payload, created_at)
      VALUES (${shopId}::uuid, 'pending', ${JSON.stringify(input)}::jsonb, ${d.clock.now()}) RETURNING id`;
    if (row === undefined) throw new Error('import batch insert returned nothing');
    await scheduleAction(tx, { kind: 'import_batch', key: row.id, dueAt: d.clock.now() });
    fx.actions.push({ kind: 'import_batch', key: row.id });
    return { batchId: row.id };
  });

export type BatchItemResult =
  | { readonly externalNumber: string; readonly ok: true; readonly orderId: string; readonly created: boolean }
  | { readonly externalNumber: string; readonly ok: false; readonly code: string; readonly message: string };

/** Idempotent: re-running a batch re-imports nothing new (every item is an idempotent import). */
export const processImportBatch = async (
  d: { readonly db: Db; readonly clock: Clock },
  fx: Effects,
  batchId: string,
): Promise<readonly BatchItemResult[]> => {
  const batch = await d.db.importBatch.findUnique({ where: { id: batchId } });
  if (batch === null) return [];
  const parsed = batchImportSchema.safeParse(batch.payload);
  if (!parsed.success) {
    await d.db.importBatch.update({ where: { id: batchId }, data: { status: 'failed', completedAt: d.clock.now() } });
    return [];
  }
  const results: BatchItemResult[] = [];
  for (const order of parsed.data.orders) {
    const r = await importOrder(d, fx, batch.shopId, order);
    results.push(
      r.ok
        ? { externalNumber: order.externalNumber, ok: true, orderId: r.value.orderId, created: r.value.created }
        : { externalNumber: order.externalNumber, ok: false, code: r.error.code, message: r.error.message },
    );
  }
  await d.db.importBatch.update({
    where: { id: batchId },
    data: { status: 'done', results: results as unknown as object, completedAt: d.clock.now() },
  });
  return results;
};
