import { describe, expect, it } from 'vitest';
import { applyApiErrors, codeOf } from './form-errors';

const apiError = (status: number, body: object) => Object.assign(new Error('x'), { status, body });

describe('field errors', () => {
  it('maps api field errors onto form fields and shows no banner when all matched', () => {
    const set: Array<[string, string]> = [];
    const banner = applyApiErrors(
      apiError(400, {
        code: 'VALIDATION_FAILED',
        message: 'invalid',
        fields: [
          { path: 'barcode', code: 'invalid_string', message: 'bad barcode' },
          { path: 'weightG', code: 'too_small', message: 'min 1' },
        ],
      }),
      (n, e) => set.push([n, e.message]),
      ['barcode', 'weightG', 'name'],
    );
    expect(set).toEqual([
      ['barcode', 'bad barcode'],
      ['weightG', 'min 1'],
    ]);
    expect(banner).toBeNull();
  });
  it('shows a banner for unmatched fields and non-validation errors', () => {
    expect(
      applyApiErrors(
        apiError(409, { code: 'DUPLICATE_BARCODE', message: 'barcode taken' }),
        () => undefined,
        ['barcode'],
      ),
    ).toBe('barcode taken');
    expect(
      applyApiErrors(
        apiError(400, {
          code: 'VALIDATION_FAILED',
          message: 'invalid',
          fields: [{ path: 'other', code: 'x', message: 'm' }],
        }),
        () => undefined,
        ['barcode'],
      ),
    ).toBe('invalid');
    expect(applyApiErrors(new Error('offline'), () => undefined, [])).toMatch(/server/);
    expect(codeOf(apiError(409, { code: 'DUPLICATE_BARCODE', message: 'm' }))).toBe('DUPLICATE_BARCODE');
  });
});
