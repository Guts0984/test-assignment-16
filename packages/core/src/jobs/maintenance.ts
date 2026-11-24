// Nightly and recurring maintenance (plan.md A-8): shelf-life revalidation of reserves, ledger
// reconciliation (a mismatch fails the job so it shows up for the admin), idempotency purge, and
// wave timers that exist for every warehouse.
import { type Db } from '@ff/db/client';
import { isBalanced, ledgerReport } from '@ff/db/ledger';
import { ok, type Result } from '@ff/shared/result';
import { addDays, localDateOf, localTimeInstant, shipDayFor } from '@ff/shared/time/calendar';
import { type Effects } from '../effects';
import { ctxOf, loadWarehouse, loadWarehouses, SYSTEM, type FloorDeps } from '../floor/context';
import { lockOrder } from '../orders/transition';
import { releaseReservations, reserveLocked } from '../floor/reserve';
import { runTx } from '../tx-result';

/** Creates the action if it does not exist; never moves an existing due time. */
export const ensureRecurring = async (
  db: Db,
  kind: 'wave_timer' | 'nightly',
  key: string,
  dueAt: Date,
): Promise<void> => {
  await db.$executeRaw`
    INSERT INTO scheduled_actions (kind, key, due_at, status) VALUES (${kind}, ${key}, ${dueAt}, 'pending')
    ON CONFLICT (kind, key) DO NOTHING`;
};

export const ensureWarehouseTimers = async (
  d: FloorDeps & { readonly nightlyLocalTime: string },
): Promise<void> => {
  const now = d.clock.now();
  for (const w of await loadWarehouses(d.db)) {
    await ensureRecurring(
      d.db,
      'wave_timer',
      w.id,
      new Date(now.getTime() + d.settings.waveIntervalMin * 60_000),
    );
    await ensureRecurring(d.db, 'nightly', w.id, nextNightly(now, w.timeZone, d.nightlyLocalTime));
  }
};

/** The next local `hhmm` strictly after `now`. */
export const nextNightly = (now: Date, timeZone: string, hhmm: string): Date => {
  const today = localDateOf(now, timeZone);
  const todayAt = localTimeInstant(today, hhmm, timeZone);
  return todayAt.getTime() > now.getTime() ? todayAt : localTimeInstant(addDays(today, 1), hhmm, timeZone);
};

/** Reserved orders whose batch no longer has the shop's minimum shelf life at the ship day are re-reserved. */
export const revalidateShelfLife = async (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
): Promise<Result<{ readonly orders: number }>> => {
  const wh = await loadWarehouse(d.db, warehouseId);
  if (wh === null) return ok({ orders: 0 });
  const asOf = shipDayFor(d.clock.now(), wh);
  const stale = await d.db.$queryRaw<{ order_id: string }[]>`
    SELECT DISTINCT r.order_id FROM order_reservations r
    JOIN orders o ON o.id = r.order_id JOIN shops s ON s.id = o.shop_id JOIN batches b ON b.id = r.batch_id
    WHERE o.warehouse_id = ${warehouseId}::uuid AND o.status = 'reserved' AND b.expires_on IS NOT NULL
      AND b.expires_on - ${asOf}::date < s.min_shelf_life_days`;
  const n = { v: 0 };
  for (const o of stale) {
    const r = await runTx<boolean>(d.db, outer, async (tx, fx) => {
      const order = await lockOrder(tx, o.order_id);
      if (order === null || order.status !== 'reserved') return ok(false);
      const ctx = ctxOf(tx, fx, d, SYSTEM, 'nightly', o.order_id, d.clock.now());
      await releaseReservations(ctx, o.order_id);
      const again = await reserveLocked(ctx, d, order);
      return again.ok ? ok(true) : again;
    });
    if (r.ok && r.value) n.v += 1;
  }
  return ok({ orders: n.v });
};

export const purgeIdempotency = async (db: Db, now: Date): Promise<number> =>
  db.$executeRaw`DELETE FROM idempotency_records WHERE created_at < ${new Date(now.getTime() - 7 * 86_400_000)}`;

/** Throws when the ledger and balances disagree, so the failure is recorded and visible to the admin. */
export const assertLedgerBalanced = async (db: Db): Promise<void> => {
  const r = await ledgerReport(db);
  if (!isBalanced(r))
    throw new Error(`ledger mismatch: ${JSON.stringify({ ...r, sample: r.sample.slice(0, 2) })}`);
};

export const nightly = async (
  d: FloorDeps & { readonly nightlyLocalTime: string },
  outer: Effects,
  warehouseId: string,
): Promise<{ readonly next: Date }> => {
  const wh = await loadWarehouse(d.db, warehouseId);
  if (wh === null) return { next: new Date(d.clock.now().getTime() + 86_400_000) };
  await revalidateShelfLife(d, outer, warehouseId);
  await purgeIdempotency(d.db, d.clock.now());
  await assertLedgerBalanced(d.db);
  return { next: nextNightly(d.clock.now(), wh.timeZone, d.nightlyLocalTime) };
};
