// Warehouse selection for a reserve (ASSIGNMENT "Reserve", plan.md A-4, A-5).
export type GeoPoint = { readonly lat: number; readonly lon: number };

export type WarehouseCoverage = {
  readonly warehouseId: string;
  readonly country: string;
  readonly location: GeoPoint | null;
  /** Units this warehouse can reserve now, per order line (same order as the order's lines). */
  readonly coverableByLine: readonly number[];
};

export type OrderNeed = {
  readonly lineQty: readonly number[];
  readonly country: string;
  readonly location: GeoPoint | null;
};

const EARTH_KM = 6371;
const rad = (d: number): number => (d * Math.PI) / 180;

export const haversineKm = (a: GeoPoint, b: GeoPoint): number => {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
};

/** Distance score: km when both points are known, else 0 for the same country and 1e6 otherwise. */
export const distanceScore = (w: WarehouseCoverage, need: OrderNeed): number => {
  if (w.location !== null && need.location !== null) return haversineKm(w.location, need.location);
  return w.country.toUpperCase() === need.country.toUpperCase() ? 0 : 1e6;
};

const unitsCovered = (w: WarehouseCoverage, need: OrderNeed): number =>
  need.lineQty.reduce((s, q, i) => s + Math.min(q, w.coverableByLine[i] ?? 0), 0);

const coversAll = (w: WarehouseCoverage, need: OrderNeed): boolean =>
  need.lineQty.every((q, i) => (w.coverableByLine[i] ?? 0) >= q);

export type WarehouseChoice = { readonly warehouseId: string; readonly full: boolean };

/**
 * Full coverage beats partial; among full ones the nearest wins. If none is full, the one covering
 * the most units wins, then the nearest. The warehouse id breaks remaining ties.
 */
export const selectWarehouse = (
  candidates: readonly WarehouseCoverage[],
  need: OrderNeed,
): WarehouseChoice | null => {
  const ranked = candidates
    .map((w) => ({ w, full: coversAll(w, need), units: unitsCovered(w, need), dist: distanceScore(w, need) }))
    .sort(
      (a, b) =>
        Number(b.full) - Number(a.full) ||
        (a.full ? 0 : b.units - a.units) ||
        a.dist - b.dist ||
        (a.w.warehouseId < b.w.warehouseId ? -1 : a.w.warehouseId > b.w.warehouseId ? 1 : 0),
    );
  const best = ranked[0];
  return best === undefined ? null : { warehouseId: best.w.warehouseId, full: best.full };
};
