import { describe, expect, it } from 'vitest';
import { seededRandom, webhookFault } from './chaos';

describe('webhook faults', () => {
  it('every fifth delivery fails, alternating 500 and timeout', () => {
    const pattern = Array.from({ length: 20 }, (_, i) => webhookFault(i + 1, true));
    expect(pattern.filter((p) => p !== 'none')).toEqual(['error500', 'timeout', 'error500', 'timeout']);
    expect(pattern[4]).toBe('error500');
    expect(pattern[9]).toBe('timeout');
    expect(pattern.slice(0, 4).every((p) => p === 'none')).toBe(true);
  });
  it('never fails when chaos is off', () => {
    expect(Array.from({ length: 50 }, (_, i) => webhookFault(i + 1, false)).every((p) => p === 'none')).toBe(true);
  });
});

describe('seeded random', () => {
  it('is reproducible and in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(xs[0]);
  });
});
