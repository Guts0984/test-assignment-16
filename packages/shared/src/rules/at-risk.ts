// "Orders at risk of missing the cutoff" for the shift dashboard (plan.md A-16).
import { type OrderStatus } from '../domain';

/** Typical remaining work in minutes before an order in this status is packed. */
export const REMAINING_WORK_MIN: Readonly<Partial<Record<OrderStatus, number>>> = {
  received: 120,
  awaiting_stock: 120,
  reserved: 90,
  in_wave: 60,
  picking: 30,
  picked: 15,
};

/**
 * At risk when not yet packed and the time left before its target cutoff is smaller than the
 * remaining work plus a safety buffer. An order whose cutoff has passed is late (also at risk).
 */
export const isAtRisk = (status: OrderStatus, targetCutoffAt: Date | null, now: Date, bufferMin: number): boolean => {
  const work = REMAINING_WORK_MIN[status];
  if (work === undefined || targetCutoffAt === null) return false;
  return targetCutoffAt.getTime() - now.getTime() < (work + bufferMin) * 60_000;
};

export const isLate = (status: OrderStatus, targetCutoffAt: Date | null, now: Date): boolean =>
  REMAINING_WORK_MIN[status] !== undefined && targetCutoffAt !== null && targetCutoffAt.getTime() <= now.getTime();
