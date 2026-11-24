import { describe, expect, it } from 'vitest';
import { clockOffset, formatCountdown, msUntil, serverNow } from './server-time';

describe('server time', () => {
  it('ignores a wrong browser clock: the countdown follows the server', () => {
    // browser clock is 2 h ahead; the request took 200 ms
    const local = Date.parse('2026-11-24T12:00:00Z');
    const sample = {
      serverNowMs: Date.parse('2026-11-24T10:00:00.100Z'),
      sentAtMs: local,
      receivedAtMs: local + 200,
    };
    const off = clockOffset(sample);
    expect(off).toBe(-2 * 3600_000);
    const cutoff = Date.parse('2026-11-24T16:00:00Z');
    expect(msUntil(cutoff, local + 200, off)).toBe(6 * 3600_000 - 200);
    expect(serverNow(local, off)).toBe(local - 2 * 3600_000);
  });
  it('formats countdowns, including after the cutoff', () => {
    expect(formatCountdown(3_909_000)).toBe('1:05:09');
    expect(formatCountdown(729_000)).toBe('12:09');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(-12_000)).toBe('late 0:12');
    expect(formatCountdown(0)).toBe('0:00');
  });
});
