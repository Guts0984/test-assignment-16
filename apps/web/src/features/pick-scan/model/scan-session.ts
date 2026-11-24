// The scanner screen as a pure state machine: what the picker must scan next, and what a result
// (or an error) does to the screen. No mouse is needed: Enter submits, the input keeps focus.
import { type ScanLine, nextLine, scanMessage, stepFor } from '@/shared/lib/scan';

export type ScanUi = {
  readonly scannedCell: string | null;
  readonly message: { readonly kind: 'ok' | 'error' | 'info'; readonly text: string } | null;
};

export const initialScanUi: ScanUi = { scannedCell: null, message: { kind: 'info', text: 'Scan the cell' } };

export type ScanInput = { readonly value: string };

/** What to submit for the typed value: a cell code, or an item barcode (+ batch when tracked). */
export const classify = (
  lines: readonly ScanLine[],
  ui: ScanUi,
  value: string,
): { readonly kind: 'cell' | 'item'; readonly value: string } => {
  const step = stepFor(lines, ui.scannedCell);
  return step === 'item' ? { kind: 'item', value } : { kind: 'cell', value };
};

export const afterCellOk = (ui: ScanUi, cell: string): ScanUi => ({
  scannedCell: cell,
  message: { kind: 'ok', text: `Cell ${cell} confirmed. Scan the item.` },
});
export const afterItemOk = (ui: ScanUi, lines: readonly ScanLine[]): ScanUi => {
  const rest = nextLine(lines);
  return rest === undefined
    ? { scannedCell: null, message: { kind: 'ok', text: 'Task complete. Hand over to packing.' } }
    : {
        scannedCell: ui.scannedCell === rest.cellCode ? ui.scannedCell : null,
        message: {
          kind: 'ok',
          text:
            ui.scannedCell === rest.cellCode
              ? 'Counted. Scan the next item.'
              : `Counted. Next cell ${rest.cellCode}.`,
        },
      };
};
export const afterError = (ui: ScanUi, code: string, fallback: string): ScanUi => ({
  ...ui,
  message: { kind: 'error', text: scanMessage(code, fallback) },
});
