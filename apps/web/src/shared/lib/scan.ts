// A scanner is keyboard input ending with Enter (ASSIGNMENT). Pure helpers for the scan flow.
export const normalizeScan = (raw: string): string => raw.replace(/[\r\n\t]/g, '').trim();

/** Each scan carries a client-generated idempotency key so a resend after a dropped connection counts once. */
export const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : `k${Date.now()}${Math.random().toString(36).slice(2, 12)}`;

export type ScanStep = 'cell' | 'item' | 'done';
export type ScanLine = {
  readonly skuName?: string;
  readonly lineId: string;
  readonly cellCode: string;
  readonly barcode: string;
  readonly qty: number;
  readonly pickedQty: number;
  readonly status: string;
  readonly batchCode: string;
  readonly tracksExpiry: boolean;
};

/** The next line to pick, following the walk route; short lines are skipped. */
export const nextLine = (lines: readonly ScanLine[]): ScanLine | undefined =>
  lines.find((l) => l.status === 'open' && l.pickedQty < l.qty);

export const stepFor = (lines: readonly ScanLine[], scannedCell: string | null): ScanStep => {
  const line = nextLine(lines);
  if (line === undefined) return 'done';
  return scannedCell === line.cellCode ? 'item' : 'cell';
};

/** Human message for an error code coming back from a scan (shown next to the beep). */
export const scanMessage = (code: string, fallback: string): string =>
  ({
    WRONG_CELL: 'Wrong cell. Go to the cell shown above.',
    WRONG_SKU: 'Wrong item. This is not the item of this line.',
    WRONG_BATCH: 'Wrong batch. Pick the batch shown above.',
    CELL_BLOCKED: 'This cell is closed (stock count). Report a shortage or wait.',
    LINE_COMPLETE: 'This line is already picked.',
    ALREADY_SCANNED: 'Too many units for this line.',
    ORDER_CANCELLED: 'The order was cancelled. Return the goods to the return cell.',
    TASK_NOT_ASSIGNED: 'This task is not yours any more.',
    IDEMPOTENCY_MISMATCH: 'Scan conflict. Scan again.',
  })[code] ?? fallback;
