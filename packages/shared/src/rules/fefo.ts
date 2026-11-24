// FEFO allocation with the shop's minimum remaining shelf life (ASSIGNMENT "Batches").
import { daysBetween } from '../time/calendar';

/** Reservable stock of one batch in one cell. */
export type StockSlot = {
  readonly cellId: string;
  readonly batchId: string;
  /** null for SKUs without expiry tracking. */
  readonly expiresOn: string | null;
  readonly batchReceivedAt: Date;
  readonly walkOrder: number;
  readonly available: number;
};

export type Allocation = { readonly cellId: string; readonly batchId: string; readonly qty: number };

/**
 * A batch is eligible when its remaining shelf life on `asOfDate` (the projected ship day) is at
 * least the shop minimum. Exactly the minimum is allowed; one day less is not.
 */
export const isBatchEligible = (expiresOn: string | null, asOfDate: string, minShelfLifeDays: number): boolean =>
  expiresOn === null || daysBetween(asOfDate, expiresOn) >= minShelfLifeDays;

/**
 * FEFO order: earliest expiry first (untracked batches last), then the older batch, then batch id,
 * then the cell earliest on the walk route, then cell id. Fully deterministic.
 */
export const fefoCompare = (a: StockSlot, b: StockSlot): number => {
  if (a.expiresOn !== b.expiresOn) {
    if (a.expiresOn === null) return 1;
    if (b.expiresOn === null) return -1;
    return a.expiresOn < b.expiresOn ? -1 : 1;
  }
  const byReceived = a.batchReceivedAt.getTime() - b.batchReceivedAt.getTime();
  if (byReceived !== 0) return byReceived;
  if (a.batchId !== b.batchId) return a.batchId < b.batchId ? -1 : 1;
  if (a.walkOrder !== b.walkOrder) return a.walkOrder - b.walkOrder;
  return a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0;
};

export const eligibleSlots = (
  slots: readonly StockSlot[],
  asOfDate: string,
  minShelfLifeDays: number,
): readonly StockSlot[] =>
  slots
    .filter((s) => s.available > 0 && isBatchEligible(s.expiresOn, asOfDate, minShelfLifeDays))
    .slice()
    .sort(fefoCompare);

/** Greedy FEFO allocation of `qty` units. Returns what was allocated and what is still missing. */
export const allocateFefo = (
  slots: readonly StockSlot[],
  qty: number,
  asOfDate: string,
  minShelfLifeDays: number,
): { readonly allocations: readonly Allocation[]; readonly missing: number } => {
  const step = (
    rest: readonly StockSlot[],
    need: number,
    acc: readonly Allocation[],
  ): { readonly allocations: readonly Allocation[]; readonly missing: number } => {
    const [head, ...tail] = rest;
    if (need === 0 || head === undefined) return { allocations: acc, missing: need };
    const take = Math.min(need, head.available);
    return step(tail, need - take, [...acc, { cellId: head.cellId, batchId: head.batchId, qty: take }]);
  };
  return step(eligibleSlots(slots, asOfDate, minShelfLifeDays), qty, []);
};

export const availableEligible = (slots: readonly StockSlot[], asOfDate: string, minShelfLifeDays: number): number =>
  eligibleSlots(slots, asOfDate, minShelfLifeDays).reduce((s, x) => s + x.available, 0);
