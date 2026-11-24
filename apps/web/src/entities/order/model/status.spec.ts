import { describe, expect, it } from 'vitest';
import { canCancel, statusLabel } from './status';

describe('order status', () => {
  it('cancel is offered exactly until packing', () => {
    expect(['received', 'awaiting_stock', 'reserved', 'in_wave', 'picking', 'picked'].every(canCancel)).toBe(
      true,
    );
    expect(['packed', 'shipped', 'cancelled'].some(canCancel)).toBe(false);
  });
  it('labels every status', () => {
    expect(statusLabel('awaiting_stock')).toBe('Awaiting stock');
    expect(statusLabel('weird')).toBe('weird');
  });
});
