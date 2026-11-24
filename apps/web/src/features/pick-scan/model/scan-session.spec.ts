import { describe, expect, it } from 'vitest';
import type { ScanLine } from '@/shared/lib/scan';
import { afterCellOk, afterError, afterItemOk, classify, initialScanUi } from './scan-session';

const line = (o: Partial<ScanLine> & { lineId: string }): ScanLine => ({
  cellCode: 'A-1',
  barcode: 'B',
  qty: 1,
  pickedQty: 0,
  status: 'open',
  batchCode: '-',
  tracksExpiry: false,
  ...o,
});

describe('scan session', () => {
  it('cell first, then item', () => {
    const lines = [line({ lineId: '1' })];
    expect(classify(lines, initialScanUi, 'A-1').kind).toBe('cell');
    expect(classify(lines, afterCellOk(initialScanUi, 'A-1'), 'B').kind).toBe('item');
  });
  it('after the last unit the screen says the task is complete', () => {
    const ui = afterCellOk(initialScanUi, 'A-1');
    expect(afterItemOk(ui, [line({ lineId: '1', pickedQty: 1, status: 'done' })]).message?.text).toMatch(
      /complete/,
    );
  });
  it('moving to another cell asks for that cell', () => {
    const ui = afterCellOk(initialScanUi, 'A-1');
    const next = afterItemOk(ui, [
      line({ lineId: '1', pickedQty: 1, status: 'done' }),
      line({ lineId: '2', cellCode: 'B-2' }),
    ]);
    expect([next.scannedCell, next.message?.text]).toEqual([null, 'Counted. Next cell B-2.']);
  });
  it('an error keeps the position and shows a clear message', () => {
    const ui = afterCellOk(initialScanUi, 'A-1');
    const err = afterError(ui, 'WRONG_SKU', 'x');
    expect(err.scannedCell).toBe('A-1');
    expect(err.message).toEqual({ kind: 'error', text: 'Wrong item. This is not the item of this line.' });
  });
});
