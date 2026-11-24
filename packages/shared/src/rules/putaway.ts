// Putaway cell suggestion (ASSIGNMENT: same batch, free space) and pick route ordering.
export type CellCandidate = {
  readonly cellId: string;
  readonly code: string;
  readonly walkOrder: number;
  readonly blocked: boolean;
  readonly capacityVolumeCm3: number;
  readonly capacityWeightG: number;
  readonly usedVolumeCm3: number;
  readonly usedWeightG: number;
  readonly holdsSameBatch: boolean;
  readonly holdsSameSku: boolean;
  readonly isEmpty: boolean;
};

export type Load = { readonly volumeCm3: number; readonly weightG: number };

export const loadOf = (qty: number, unitVolumeCm3: number, unitWeightG: number): Load => ({
  volumeCm3: qty * unitVolumeCm3,
  weightG: qty * unitWeightG,
});

export const fits = (c: CellCandidate, load: Load): boolean =>
  c.usedVolumeCm3 + load.volumeCm3 <= c.capacityVolumeCm3 && c.usedWeightG + load.weightG <= c.capacityWeightG;

const rank = (c: CellCandidate): number => (c.holdsSameBatch ? 0 : c.holdsSameSku ? 1 : c.isEmpty ? 2 : 3);

/** Unblocked cells that fit the load: same batch first, then same SKU, then empty, then any; by walk order. */
export const suggestCells = (cells: readonly CellCandidate[], load: Load): readonly CellCandidate[] =>
  cells
    .filter((c) => !c.blocked && fits(c, load))
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.walkOrder - b.walkOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

export type RouteStop = { readonly walkOrder: number; readonly cellCode: string };

/** Pick route: walk order through the warehouse, cell code as a tie-break. */
export const sortRoute = <T extends RouteStop>(stops: readonly T[]): readonly T[] =>
  stops
    .slice()
    .sort((a, b) => a.walkOrder - b.walkOrder || (a.cellCode < b.cellCode ? -1 : a.cellCode > b.cellCode ? 1 : 0));
