// Stock count thresholds (ASSIGNMENT "Stock count": > 5 units or > 10% needs shift-lead approval).
export const COUNT_UNIT_THRESHOLD = 5;
export const COUNT_PERCENT_THRESHOLD = 10;

export type CountLineOutcome = {
  readonly systemQty: number;
  readonly countedQty: number;
  readonly delta: number;
  readonly requiresApproval: boolean;
};

/**
 * Integer math avoids float edges: exactly 5 units or exactly 10% is auto-approved; anything above
 * needs approval. Any find in a cell the system thinks is empty counts as more than 10% (A-17).
 */
export const requiresApproval = (systemQty: number, countedQty: number): boolean => {
  const diff = Math.abs(countedQty - systemQty);
  if (diff > COUNT_UNIT_THRESHOLD) return true;
  if (systemQty === 0) return diff > 0;
  return diff * 100 > systemQty * COUNT_PERCENT_THRESHOLD;
};

export const evaluateCountLine = (systemQty: number, countedQty: number): CountLineOutcome => ({
  systemQty,
  countedQty,
  delta: countedQty - systemQty,
  requiresApproval: requiresApproval(systemQty, countedQty),
});

/** A count needs approval when any of its lines does. */
export const countRequiresApproval = (lines: readonly CountLineOutcome[]): boolean =>
  lines.some((l) => l.requiresApproval);
