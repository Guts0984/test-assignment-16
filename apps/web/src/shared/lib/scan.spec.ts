import { describe, expect, it } from 'vitest';
import { newIdempotencyKey, nextLine, normalizeScan, scanMessage, stepFor, type ScanLine } from './scan';

const line = (o: Partial<ScanLine> & { lineId: string }): ScanLine => ({
  cellCode: 'A-1',
  barcode: 'B',
  qty: 2,
  pickedQty: 0,
  status: 'open',
  batchCode: '-',
  tracksExpiry: false,
  ...o,
});

describe('scan flow', () => {
  it('strips the Enter and whitespace a scanner appends', () => {
    expect(normalizeScan('  A-001\r\n')).toBe('A-001');
    expect(normalizeScan('A\t-1')).toBe('A-1');
  });
  it('asks for the cell first, then the item, then is done', () => {
    const lines = [line({ lineId: '1', cellCode: 'A-1' }), line({ lineId: '2', cellCode: 'B-2' })];
    expect(stepFor(lines, null)).toBe('cell');
    expect(stepFor(lines, 'B-2')).toBe('cell');
    expect(stepFor(lines, 'A-1')).toBe('item');
    expect(stepFor([line({ lineId: '1', pickedQty: 2, status: 'done' })], 'A-1')).toBe('done');
  });
  it('skips short and finished lines', () => {
    expect(
      nextLine([
        line({ lineId: '1', status: 'short' }),
        line({ lineId: '2', pickedQty: 2 }),
        line({ lineId: '3' }),
      ])?.lineId,
    ).toBe('3');
  });
  it('idempotency keys are unique and accepted by the api format', () => {
    const keys = new Set(Array.from({ length: 200 }, newIdempotencyKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  });
  it('every error code the picker can hit has a clear message', () => {
    for (const c of [
      'WRONG_CELL',
      'WRONG_SKU',
      'WRONG_BATCH',
      'CELL_BLOCKED',
      'LINE_COMPLETE',
      'ORDER_CANCELLED',
    ])
      expect(scanMessage(c, 'x')).not.toBe('x');
    expect(scanMessage('SOMETHING', 'fallback')).toBe('fallback');
  });
});
