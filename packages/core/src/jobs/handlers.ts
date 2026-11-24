// Action handlers. Every handler is idempotent: running it twice, or after a crash mid-way, has the
// same effect as once (each use-case re-checks state under row locks).
import { type DomainError, type Result } from '@ff/shared/result';
import { processImportBatch } from '../orders/import-batch';
import { expirePartialReserve, rereserve, reserveOrder } from '../floor/reserve';
import { formWave, waveCheck } from '../floor/waves';
import { nextWaveDueAt } from '@ff/shared/rules/wave';
import { type Handler, type JobDeps } from './run-action';

/** Unexpected domain failures are retried and eventually surface as dead jobs for the admin. */
const must = <T>(r: Result<T>): T => {
  if (r.ok) return r.value;
  const e: DomainError = r.error;
  throw new Error(`${e.code}: ${e.message}`);
};

export const floorHandlers = (d: Omit<JobDeps, 'handlers'>): Partial<Record<string, Handler>> => ({
  reserve_order: async (row, fx) => {
    must(await reserveOrder(d, fx, row.key));
    return { next: null };
  },
  rereserve: async (row, fx) => {
    const [warehouseId = '', skuId = ''] = row.key.split('|');
    must(await rereserve(d, fx, warehouseId, skuId));
    return { next: null };
  },
  wave_check: async (row, fx) => {
    must(await waveCheck(d, fx, row.key));
    return { next: null };
  },
  wave_timer: async (row, fx) => {
    must(await formWave(d, fx, row.key, 'timer', null));
    return { next: nextWaveDueAt(d.clock.now(), d.settings.waveIntervalMin) };
  },
  partial_reserve_expiry: async (row, fx) => {
    must(await expirePartialReserve(d, fx, row.key));
    return { next: null };
  },
  import_batch: async (row, fx) => {
    await processImportBatch(d, fx, row.key);
    return { next: null };
  },
});
