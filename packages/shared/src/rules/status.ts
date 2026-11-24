// Order status transitions: the single source for api, worker, web and the README table.
import { type Actor, type OrderStatus } from '../domain';
import { fail, ok, type Result } from '../result';

export type Transition = {
  readonly from: OrderStatus | null;
  readonly to: OrderStatus;
  readonly actors: readonly Actor[];
  readonly when: string;
};

export const CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  'received',
  'awaiting_stock',
  'reserved',
  'in_wave',
  'picking',
  'picked',
];

export const TRANSITIONS: readonly Transition[] = [
  { from: null, to: 'received', actors: ['shop', 'system'], when: 'order accepted (API, cabinet or import job)' },
  { from: 'received', to: 'reserved', actors: ['system'], when: 'every line reserved at one warehouse' },
  { from: 'received', to: 'awaiting_stock', actors: ['system'], when: 'partial or no reserve' },
  { from: 'awaiting_stock', to: 'reserved', actors: ['system'], when: 'missing quantity reserved (re-reserve)' },
  {
    from: 'reserved',
    to: 'awaiting_stock',
    actors: ['system'],
    when: 'a count, shortage or shelf-life check moved the reserve away and no stock is left',
  },
  { from: 'reserved', to: 'in_wave', actors: ['system', 'shift_lead'], when: 'wave formed (timer, 50 ready, or manual)' },
  { from: 'in_wave', to: 'awaiting_stock', actors: ['system'], when: 'a count or shortage left no alternative stock' },
  { from: 'in_wave', to: 'picking', actors: ['picker', 'shift_lead'], when: 'a picker takes or is assigned the task' },
  { from: 'picking', to: 'picked', actors: ['picker'], when: 'the last line is scanned' },
  { from: 'picking', to: 'awaiting_stock', actors: ['system'], when: 'a shortage left no alternative stock' },
  { from: 'picked', to: 'packed', actors: ['packer', 'shift_lead'], when: 'order scanned at packing, label printed' },
  { from: 'packed', to: 'shipped', actors: ['storekeeper', 'shift_lead'], when: 'handed over to the carrier' },
  ...CANCELLABLE_STATUSES.map(
    (from): Transition => ({
      from,
      to: 'cancelled',
      actors: ['shop', 'admin'],
      when:
        from === 'picking' || from === 'picked'
          ? 'cancel: picked goods go to the return cell, the rest of the reserve is released'
          : 'cancel: the reserve is released',
    }),
  ),
];

export const canTransition = (from: OrderStatus | null, to: OrderStatus, actor: Actor): Result<Transition> => {
  const t = TRANSITIONS.find((x) => x.from === from && x.to === to);
  if (t === undefined) return fail('INVALID_TRANSITION', `order cannot go from ${from ?? 'none'} to ${to}`);
  if (!t.actors.includes(actor)) return fail('FORBIDDEN', `${actor} cannot move an order from ${from ?? 'none'} to ${to}`);
  return ok(t);
};

export const isCancellable = (s: OrderStatus): boolean => CANCELLABLE_STATUSES.includes(s);

/** Statuses from which `to` is reachable in one step. Used to build conditional SQL updates. */
export const sourcesOf = (to: OrderStatus): readonly OrderStatus[] =>
  TRANSITIONS.filter((t) => t.to === to && t.from !== null).map((t) => t.from as OrderStatus);

/** Markdown table for the README, generated so it can never drift from the code. */
export const transitionTableMarkdown = (): string => {
  const rows = TRANSITIONS.map(
    (t) => `| ${t.from === null ? '-' : `\`${t.from}\``} | \`${t.to}\` | ${t.actors.join(', ')} | ${t.when} |`,
  );
  const refused =
    '| `packed`, `shipped` | `cancelled` | - | refused with `ORDER_NOT_CANCELLABLE` (see decision D-3); cancelling an already cancelled order is a no-op |';
  return ['| From | To | Who | When |', '| --- | --- | --- | --- |', ...rows, refused].join('\n');
};
