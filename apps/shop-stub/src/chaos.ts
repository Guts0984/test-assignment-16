// Chaos mode (ASSIGNMENT "Shop stub"): every fifth webhook fails (alternating 500 and timeout),
// orders go to both api copies at once, and some orders are cancelled right after creation.
export type WebhookFault = 'none' | 'error500' | 'timeout';

/** Deterministic: the 5th, 15th, 25th... delivery gets 500; the 10th, 20th... a timeout. */
export const webhookFault = (deliveryNumber: number, enabled: boolean, failEvery = 5): WebhookFault => {
  if (!enabled || failEvery <= 0 || deliveryNumber % failEvery !== 0) return 'none';
  return (deliveryNumber / failEvery) % 2 === 1 ? 'error500' : 'timeout';
};

/** mulberry32: a tiny seeded PRNG so chaos runs are reproducible. */
export const seededRandom = (seed: number): (() => number) => {
  const s = { v: seed >>> 0 };
  return () => {
    s.v = (s.v + 0x6d2b79f5) >>> 0;
    let t = s.v;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export type ChaosSettings = { enabled: boolean; cancelRate: number; failEvery: number; timeoutHoldMs: number };
