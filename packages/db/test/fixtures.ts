// Minimal fixtures for db-level tests. Each call creates fresh, uniquely named rows.
import { randomUUID } from 'node:crypto';
import { type Db } from '../src/client';

export const uniq = (p: string): string => `${p}-${randomUUID().slice(0, 8)}`.toUpperCase();

export const makeWarehouseWithCells = async (db: Db, cells = 2) => {
  const wh = await db.warehouse.create({
    data: {
      code: uniq('WH'),
      name: 'Test',
      country: 'PL',
      timeZone: 'Europe/Warsaw',
      cutoffLocal: '17:00',
      workingDays: [1, 2, 3, 4, 5],
    },
  });
  const created = await Promise.all(
    Array.from({ length: cells }, (_, i) =>
      db.location.create({
        data: {
          warehouseId: wh.id,
          kind: 'storage',
          code: `C-${i}`,
          walkOrder: i,
          capacityVolumeCm3: 1_000_000,
          capacityWeightG: 1_000_000,
        },
      }),
    ),
  );
  return { wh, cells: created };
};

export const makeSku = async (db: Db) => {
  const shop = await db.shop.create({
    data: { code: uniq('SHOP'), name: 'S', webhookUrl: 'http://x.test', webhookSecretEnc: 'x', minShelfLifeDays: 0 },
  });
  const sku = await db.sku.create({
    data: {
      shopId: shop.id,
      code: uniq('SKU'),
      name: 'Thing',
      barcode: uniq('BC'),
      weightG: 100,
      lengthMm: 10,
      widthMm: 10,
      heightMm: 10,
      tracksExpiry: false,
    },
  });
  const batch = await db.batch.create({ data: { skuId: sku.id, code: '-' } });
  return { shop, sku, batch };
};
