import { describe, expect, it } from 'vitest';
import { parseLines } from './parse-lines';

describe('parseLines', () => {
  it('reads SKU and quantity separated by comma, space or tab', () => {
    expect(parseLines('A-1, 5\nB_2 10\n\nC.3\t7').lines).toEqual([
      { sku: 'A-1', qty: 5 },
      { sku: 'B_2', qty: 10 },
      { sku: 'C.3', qty: 7 },
    ]);
  });
  it('reports the bad line numbers', () => {
    const r = parseLines('A-1, 5\nnonsense\nB, -2');
    expect(r.errors).toEqual(['line 2: use "SKU, quantity"', 'line 3: use "SKU, quantity"']);
    expect(r.lines).toHaveLength(1);
  });
});
