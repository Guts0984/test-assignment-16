import { Inject, Injectable } from '@nestjs/common';
import { type Sku } from '@ff/db/client';
import { type Db } from '@ff/db/client';
import { pgConstraint, pgCode, SQLSTATE } from '@ff/db/pg-errors';
import { shopSkuPage } from '@ff/core/stock/view';
import { fail, ok, type Result } from '@ff/shared/result';
import { type CreateSkuInput } from '@ff/shared/schemas/setup';
import { DB } from '../../infra/tokens';

export const toSku = (s: Sku) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  barcode: s.barcode,
  weightG: s.weightG,
  lengthMm: s.lengthMm,
  widthMm: s.widthMm,
  heightMm: s.heightMm,
  tracksExpiry: s.tracksExpiry,
});

@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(shopId: string, input: CreateSkuInput): Promise<Result<ReturnType<typeof toSku>>> {
    try {
      const s = await this.db.$transaction(async (tx) => {
        const sku = await tx.sku.create({ data: { ...input, shopId } });
        // Untracked SKUs use one implicit batch; tracked ones get batches at receipt.
        if (!input.tracksExpiry) await tx.batch.create({ data: { skuId: sku.id, code: '-' } });
        return sku;
      });
      return ok(toSku(s));
    } catch (e) {
      if (pgCode(e) !== SQLSTATE.uniqueViolation) throw e;
      return (pgConstraint(e) ?? '').includes('barcode')
        ? fail('DUPLICATE_BARCODE', 'this shop already has a SKU with this barcode')
        : fail('DUPLICATE_CODE', 'this shop already has a SKU with this code');
    }
  }

  async get(shopId: string, id: string): Promise<Result<ReturnType<typeof toSku>>> {
    const s = await this.db.sku.findFirst({ where: { id, shopId } });
    return s === null ? fail('NOT_FOUND', 'SKU not found') : ok(toSku(s));
  }

  async update(shopId: string, id: string, patch: Partial<CreateSkuInput>): Promise<Result<ReturnType<typeof toSku>>> {
    if ((await this.db.sku.count({ where: { id, shopId } })) === 0) return fail('NOT_FOUND', 'SKU not found');
    await this.db.sku.updateMany({ where: { id, shopId }, data: patch });
    return this.get(shopId, id);
  }

  async page(shopId: string, q: { q?: string; limit: number; cursor?: string }) {
    const page = await shopSkuPage(this.db, shopId, q.q, q.limit, q.cursor);
    const rows = await this.db.sku.findMany({ where: { id: { in: page.items.map((i) => i.id) } }, orderBy: { code: 'asc' } });
    return { items: rows.map(toSku), nextCursor: page.nextCursor };
  }
}
