import { describe, expect, it } from 'vitest';
import { all, err, fail, flatMap, map, ok } from './result';
import { ERROR_CODES, errorBodySchema, httpStatusFor } from './errors';

describe('result', () => {
  it('maps only ok values', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    const e = err('x');
    expect(map(e, (n: number) => n * 3)).toBe(e);
  });

  it('flatMap short-circuits on the first error', () => {
    const calls: number[] = [];
    const r = flatMap(fail('WRONG_CELL', 'nope'), (v: number) => {
      calls.push(v);
      return ok(v);
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('all returns the first error, else every value in order', () => {
    expect(all([ok(1), ok(2)])).toEqual(ok([1, 2]));
    expect(all([ok(1), err('a'), err('b')])).toEqual(err('a'));
    expect(all([])).toEqual(ok([]));
  });

  it('fail omits details when not given', () => {
    expect(fail('CELL_BLOCKED', 'blocked')).toEqual({ ok: false, error: { code: 'CELL_BLOCKED', message: 'blocked' } });
  });
});

describe('errors', () => {
  it('codes are unique', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('maps statuses, with 422 for business rule failures', () => {
    expect(httpStatusFor('VALIDATION_FAILED')).toBe(400);
    expect(httpStatusFor('FORBIDDEN')).toBe(403);
    expect(httpStatusFor('ORDER_CONFLICT')).toBe(409);
    expect(httpStatusFor('INSUFFICIENT_STOCK')).toBe(422);
    expect(httpStatusFor('PAYLOAD_TOO_LARGE')).toBe(413);
  });

  it('error body rejects unknown codes', () => {
    expect(errorBodySchema.safeParse({ error: { code: 'BOOM', message: 'x', requestId: 'r' } }).success).toBe(false);
    expect(errorBodySchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x', requestId: 'r' } }).success).toBe(true);
  });
});
