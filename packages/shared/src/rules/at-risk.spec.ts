import { describe, expect, it } from 'vitest';
import { isAtRisk, isLate } from './at-risk';

const now = new Date('2026-11-24T14:00:00Z');
const cutoff = new Date('2026-11-24T16:00:00Z'); // 120 min left

describe('at risk', () => {
  it('depends on remaining work plus buffer', () => {
    expect(isAtRisk('picked', cutoff, now, 60)).toBe(false); // 75 < 120
    expect(isAtRisk('reserved', cutoff, now, 60)).toBe(true); // 150 > 120
    expect(isAtRisk('picking', cutoff, now, 90)).toBe(false); // exactly 120: not at risk
    expect(isAtRisk('picking', cutoff, now, 91)).toBe(true);
  });
  it('packed, shipped and cancelled orders are never at risk', () => {
    expect(isAtRisk('packed', cutoff, now, 999)).toBe(false);
    expect(isAtRisk('shipped', cutoff, now, 999)).toBe(false);
    expect(isAtRisk('cancelled', cutoff, now, 999)).toBe(false);
  });
  it('late once the cutoff has passed', () => {
    expect(isLate('in_wave', new Date('2026-11-24T14:00:00Z'), now)).toBe(true);
    expect(isLate('in_wave', cutoff, now)).toBe(false);
    expect(isLate('packed', new Date('2026-11-23T00:00:00Z'), now)).toBe(false);
  });
});
