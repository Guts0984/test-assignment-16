// Acceptance #13: after everything above, the sum of the movement ledger equals the current stock
// for every cell and batch of the whole database, and nothing is negative or over-reserved.
import { beforeAll, describe, expect, it } from 'vitest';
import { ledgerReport } from '@ff/db/ledger';
import { ledger } from '../harness/attacker';
import { ensureStack, getStack } from '../harness/global';

beforeAll(async () => void (await ensureStack()));

describe('acceptance #13: ledger vs stock after all the checks', () => {
  it('matches per cell and batch, reservations agree with balances and order lines, nothing negative', async () => {
    await ledger.assertBalanced();
    const r = await ledgerReport(getStack().db);
    expect(r).toMatchObject({
      ledgerMismatches: 0,
      reservationMismatches: 0,
      lineMismatches: 0,
      negativeBalances: 0,
    });
    const [movements] = await getStack().db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM stock_movements`;
    expect(movements?.n ?? 0).toBeGreaterThan(0);
    const [doubleWave] = await getStack().db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM (SELECT order_id FROM wave_orders WHERE active GROUP BY order_id HAVING count(*) > 1) x`;
    expect(doubleWave?.n ?? 0).toBe(0);
    const [doubleReserve] = await getStack().db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM order_lines WHERE reserved_qty + picked_qty > qty`;
    expect(doubleReserve?.n ?? 0).toBe(0);
  });
});
