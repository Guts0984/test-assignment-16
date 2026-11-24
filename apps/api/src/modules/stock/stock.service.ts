import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@ff/db/client';
import { type Clock } from '@ff/core/clock';
import { shopSkuPage, stockForSkus, type StockRow } from '@ff/core/stock/view';
import { CLOCK, DB } from '../../infra/tokens';

const group = (rows: readonly StockRow[]) => {
  const bySku = new Map<string, { skuId: string; skuCode: string; skuName: string; warehouses: object[] }>();
  for (const r of rows) {
    const e = bySku.get(r.skuId) ?? {
      skuId: r.skuId,
      skuCode: r.skuCode,
      skuName: r.skuName,
      warehouses: [],
    };
    e.warehouses.push({
      warehouseId: r.warehouseId,
      warehouseCode: r.warehouseCode,
      onShelf: r.onShelf,
      reserved: r.reserved,
      available: r.available,
      inTransit: r.inTransit,
      receiving: r.receiving,
    });
    bySku.set(r.skuId, e);
  }
  return [...bySku.values()];
};

@Injectable()
export class StockService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async shopStock(shopId: string, q: { q?: string; warehouseId?: string; limit: number; cursor?: string }) {
    const now = this.clock.now();
    const page = await shopSkuPage(this.db, shopId, q.q, q.limit, q.cursor);
    const rows = await stockForSkus(
      this.db,
      page.items.map((i) => i.id),
      now.toISOString().slice(0, 10),
      q.warehouseId ?? null,
    );
    return { items: group(rows), nextCursor: page.nextCursor, asOf: now.toISOString() };
  }

  /** Staff view of one barcode/code across all shops, at one warehouse. */
  async warehouseStock(warehouseId: string, sku: string) {
    const now = this.clock.now();
    const skus = await this.db.sku.findMany({ where: { OR: [{ barcode: sku }, { code: sku }] }, take: 50 });
    const rows = await stockForSkus(
      this.db,
      skus.map((s) => s.id),
      now.toISOString().slice(0, 10),
      warehouseId,
    );
    return { items: group(rows), nextCursor: null, asOf: now.toISOString() };
  }
}
