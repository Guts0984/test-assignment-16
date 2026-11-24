import { describe, expect, it } from 'vitest';
import { haversineKm, selectWarehouse, type OrderNeed, type WarehouseCoverage } from './warehouse-select';

const KYIV = { lat: 50.45, lon: 30.52 };
const WARSAW = { lat: 52.23, lon: 21.01 };
const LVIV = { lat: 49.84, lon: 24.03 };

const wh = (id: string, coverable: number[], o: Partial<WarehouseCoverage> = {}): WarehouseCoverage => ({
  warehouseId: id,
  country: 'UA',
  location: null,
  coverableByLine: coverable,
  ...o,
});
const need = (lineQty: number[], o: Partial<OrderNeed> = {}): OrderNeed => ({
  lineQty,
  country: 'UA',
  location: null,
  ...o,
});

describe('selectWarehouse', () => {
  it('a warehouse covering every line beats a nearer one that covers only part', () => {
    const r = selectWarehouse(
      [wh('near', [5, 0], { location: LVIV }), wh('far', [5, 5], { location: WARSAW, country: 'PL' })],
      need([5, 5], { location: LVIV }),
    );
    expect(r).toEqual({ warehouseId: 'far', full: true });
  });
  it('among full warehouses, the nearest wins', () => {
    const r = selectWarehouse(
      [wh('kyiv', [5], { location: KYIV }), wh('warsaw', [5], { location: WARSAW, country: 'PL' })],
      need([5], { location: LVIV }),
    );
    expect(r?.warehouseId).toBe('warsaw');
    expect(haversineKm(LVIV, WARSAW)).toBeLessThan(haversineKm(LVIV, KYIV));
  });
  it('without coordinates, a same-country warehouse is nearer', () => {
    const r = selectWarehouse([wh('pl', [5], { country: 'PL' }), wh('ua', [5])], need([5], { country: 'pl' }));
    expect(r?.warehouseId).toBe('pl');
  });
  it('none full: the one covering the most units wins, partial', () => {
    const r = selectWarehouse([wh('a', [1, 1]), wh('b', [3, 0])], need([5, 5]));
    expect(r).toEqual({ warehouseId: 'b', full: false });
  });
  it('a complete tie is broken by warehouse id', () => {
    expect(selectWarehouse([wh('b', [5]), wh('a', [5])], need([5]))?.warehouseId).toBe('a');
  });
  it('a warehouse with nothing still gets the order (awaiting stock) when it is the only one', () => {
    expect(selectWarehouse([wh('only', [0])], need([5]))).toEqual({ warehouseId: 'only', full: false });
  });
  it('no warehouses: null', () => expect(selectWarehouse([], need([1]))).toBeNull());
});
