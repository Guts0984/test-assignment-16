import { describe, expect, it } from 'vitest';
import { addDays } from '../time/calendar';
import { allocateFefo, availableEligible, isBatchEligible, type StockSlot } from './fefo';

const today = '2026-11-24';
const slot = (o: Partial<StockSlot> & { batchId: string }): StockSlot => ({
  cellId: `cell-${o.batchId}`,
  expiresOn: null,
  batchReceivedAt: new Date('2026-01-01T00:00:00Z'),
  walkOrder: 1,
  available: 10,
  ...o,
});

describe('acceptance #4: batches at 10, 40, 90 days, shop minimum 30', () => {
  const slots = [
    slot({ batchId: 'b90', expiresOn: addDays(today, 90) }),
    slot({ batchId: 'b10', expiresOn: addDays(today, 10) }),
    slot({ batchId: 'b40', expiresOn: addDays(today, 40) }),
  ];
  it('reserves from the 40-day batch and never touches the 10-day one', () => {
    expect(allocateFefo(slots, 5, today, 30)).toEqual({
      allocations: [{ cellId: 'cell-b40', batchId: 'b40', qty: 5 }],
      missing: 0,
    });
  });
  it('when the 40-day batch runs out partway, continues with 90, still not 10', () => {
    expect(allocateFefo(slots, 15, today, 30)).toEqual({
      allocations: [
        { cellId: 'cell-b40', batchId: 'b40', qty: 10 },
        { cellId: 'cell-b90', batchId: 'b90', qty: 5 },
      ],
      missing: 0,
    });
  });
  it('reports what is missing instead of using an ineligible batch', () => {
    const r = allocateFefo(slots, 25, today, 30);
    expect(r.missing).toBe(5);
    expect(r.allocations.some((a) => a.batchId === 'b10')).toBe(false);
    expect(availableEligible(slots, today, 30)).toBe(20);
  });
});

describe('minimum shelf life boundary', () => {
  it('exactly the minimum is eligible', () => expect(isBatchEligible(addDays(today, 30), today, 30)).toBe(true));
  it('one day under is not', () => expect(isBatchEligible(addDays(today, 29), today, 30)).toBe(false));
  it('one day over is', () => expect(isBatchEligible(addDays(today, 31), today, 30)).toBe(true));
  it('expired batches are never eligible, even with minimum 0', () =>
    expect(isBatchEligible(addDays(today, -1), today, 0)).toBe(false));
  it('untracked batches are always eligible', () => expect(isBatchEligible(null, today, 365)).toBe(true));
});

describe('FEFO ordering', () => {
  it('equal expiries: older batch first, then batch id, then walk order', () => {
    const exp = addDays(today, 50);
    const slots = [
      slot({ batchId: 'z', expiresOn: exp, batchReceivedAt: new Date('2026-03-01') }),
      slot({ batchId: 'y', expiresOn: exp, batchReceivedAt: new Date('2026-02-01'), cellId: 'c2', walkOrder: 9 }),
      slot({ batchId: 'y', expiresOn: exp, batchReceivedAt: new Date('2026-02-01'), cellId: 'c1', walkOrder: 3 }),
    ];
    const r = allocateFefo(slots, 25, today, 0);
    expect(r.allocations.map((a) => `${a.batchId}/${a.cellId}`)).toEqual(['y/c1', 'y/c2', 'z/cell-z']);
  });
  it('tracked batches come before untracked ones', () => {
    const slots = [slot({ batchId: 'none' }), slot({ batchId: 'dated', expiresOn: addDays(today, 100) })];
    expect(allocateFefo(slots, 1, today, 0).allocations[0]?.batchId).toBe('dated');
  });
  it('skips empty slots and allocates nothing for zero qty', () => {
    const slots = [slot({ batchId: 'a', available: 0 }), slot({ batchId: 'b', available: 3 })];
    expect(allocateFefo(slots, 0, today, 0)).toEqual({ allocations: [], missing: 0 });
    expect(allocateFefo(slots, 2, today, 0).allocations).toEqual([{ cellId: 'cell-b', batchId: 'b', qty: 2 }]);
  });
  it('property: allocation never exceeds slot availability nor the request', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const slots = Array.from({ length: (seed % 7) + 1 }, (_, i) =>
        slot({
          batchId: `b${i}`,
          cellId: `c${i}`,
          available: (seed * (i + 3)) % 13,
          expiresOn: addDays(today, ((seed + i * 17) % 120) - 10),
        }),
      );
      const qty = seed % 40;
      const min = seed % 45;
      const r = allocateFefo(slots, qty, today, min);
      const total = r.allocations.reduce((s, a) => s + a.qty, 0);
      expect(total + r.missing).toBe(qty);
      expect(total).toBeLessThanOrEqual(availableEligible(slots, today, min));
      for (const a of r.allocations) {
        const s = slots.find((x) => x.cellId === a.cellId);
        expect(a.qty).toBeGreaterThan(0);
        expect(a.qty).toBeLessThanOrEqual(s?.available ?? 0);
        expect(isBatchEligible(s?.expiresOn ?? null, today, min)).toBe(true);
      }
    }
  });
});
