// Seed sizes. "full" is the assignment's volume; "small" is used by every test run (plan.md A-35).
export type SeedProfile = {
  readonly name: 'small' | 'full';
  readonly skusPerShop: number;
  readonly cellsPerWarehouse: number;
  readonly historicOrders: number;
  readonly liveOrdersPerWarehouse: number;
  readonly adjustments: number;
  readonly shortages: number;
  /** Every SKU whose number is a multiple of this has no stock (for awaiting_stock orders). */
  readonly unstockedEvery: number;
};

export const PROFILES: Readonly<Record<'small' | 'full', SeedProfile>> = {
  full: {
    name: 'full',
    skusPerShop: 4000,
    cellsPerWarehouse: 3000,
    historicOrders: 200_000,
    liveOrdersPerWarehouse: 150,
    adjustments: 3000,
    shortages: 2000,
    unstockedEvery: 80,
  },
  small: {
    name: 'small',
    skusPerShop: 40,
    cellsPerWarehouse: 50,
    historicOrders: 1000,
    liveOrdersPerWarehouse: 15,
    adjustments: 30,
    shortages: 20,
    unstockedEvery: 10,
  },
};
