import { describe, expect, it } from 'vitest';
import { ACTORS, ORDER_STATUSES, type Actor, type OrderStatus } from '../domain';
import { canTransition, isCancellable, sourcesOf, transitionTableMarkdown } from './status';

// Expected matrix written out independently from TRANSITIONS so the table cannot silently change.
const ALLOWED: ReadonlyArray<readonly [OrderStatus | null, OrderStatus, readonly Actor[]]> = [
  [null, 'received', ['shop', 'system']],
  ['received', 'reserved', ['system']],
  ['received', 'awaiting_stock', ['system']],
  ['awaiting_stock', 'reserved', ['system']],
  ['reserved', 'awaiting_stock', ['system']],
  ['reserved', 'in_wave', ['system', 'shift_lead']],
  ['in_wave', 'awaiting_stock', ['system']],
  ['in_wave', 'picking', ['picker', 'shift_lead']],
  ['picking', 'picked', ['picker']],
  ['picking', 'awaiting_stock', ['system']],
  ['picked', 'packed', ['packer', 'shift_lead']],
  ['packed', 'shipped', ['storekeeper', 'shift_lead']],
  ['received', 'cancelled', ['shop', 'admin']],
  ['awaiting_stock', 'cancelled', ['shop', 'admin']],
  ['reserved', 'cancelled', ['shop', 'admin']],
  ['in_wave', 'cancelled', ['shop', 'admin']],
  ['picking', 'cancelled', ['shop', 'admin']],
  ['picked', 'cancelled', ['shop', 'admin']],
];

describe('status transitions: exhaustive from x to x actor matrix', () => {
  const froms: ReadonlyArray<OrderStatus | null> = [null, ...ORDER_STATUSES];
  for (const from of froms) {
    for (const to of ORDER_STATUSES) {
      for (const actor of ACTORS) {
        const row = ALLOWED.find(([f, t]) => f === from && t === to);
        const expected = row === undefined ? 'INVALID_TRANSITION' : row[2].includes(actor) ? 'OK' : 'FORBIDDEN';
        it(`${from ?? 'none'} -> ${to} by ${actor}: ${expected}`, () => {
          const r = canTransition(from, to, actor);
          expect(r.ok ? 'OK' : r.error.code).toBe(expected);
        });
      }
    }
  }
});

describe('cancel rules (D-3)', () => {
  it('packed, shipped and cancelled are not cancellable', () => {
    expect(isCancellable('packed')).toBe(false);
    expect(isCancellable('shipped')).toBe(false);
    expect(isCancellable('cancelled')).toBe(false);
    expect(isCancellable('picked')).toBe(true);
  });
  it('sourcesOf lists all statuses that may reach a target', () => {
    expect([...sourcesOf('awaiting_stock')].sort()).toEqual(['in_wave', 'picking', 'received', 'reserved']);
  });
  it('the README table lists every allowed transition', () => {
    const md = transitionTableMarkdown();
    expect(md.split('\n').length).toBe(2 + ALLOWED.length + 1);
  });
});
