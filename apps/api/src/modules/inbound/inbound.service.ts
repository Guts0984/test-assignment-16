import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@ff/db/client';
import { pgCode, SQLSTATE } from '@ff/db/pg-errors';
import { fail, ok, type Result } from '@ff/shared/result';
import { DB } from '../../infra/tokens';

type Input = { warehouseId: string; reference: string; lines: readonly { sku: string; qty: number }[] };

@Injectable()
export class InboundService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(shopId: string, input: Input): Promise<Result<unknown>> {
    if ((await this.db.warehouse.count({ where: { id: input.warehouseId } })) === 0)
      return fail('NOT_FOUND', 'warehouse not found');
    const skus = await this.db.sku.findMany({
      where: { shopId, code: { in: input.lines.map((l) => l.sku) } },
    });
    const byCode = new Map(skus.map((s) => [s.code, s.id]));
    const missing = input.lines.filter((l) => !byCode.has(l.sku)).map((l) => l.sku);
    if (missing.length > 0) return fail('UNKNOWN_SKU', 'unknown SKU codes for this shop', { skus: missing });
    try {
      const row = await this.db.inboundRequest.create({
        data: {
          shopId,
          warehouseId: input.warehouseId,
          reference: input.reference,
          lines: { create: input.lines.map((l) => ({ skuId: byCode.get(l.sku) ?? '', expectedQty: l.qty })) },
        },
      });
      return this.get(shopId, row.id);
    } catch (e) {
      if (pgCode(e) === SQLSTATE.uniqueViolation)
        return fail('DUPLICATE_CODE', 'an inbound request with this reference exists');
      throw e;
    }
  }

  async get(shopId: string | null, id: string): Promise<Result<unknown>> {
    const r = await this.db.inboundRequest.findFirst({
      where: { id, ...(shopId === null ? {} : { shopId }) },
      include: { lines: true },
    });
    if (r === null) return fail('NOT_FOUND', 'inbound request not found');
    return ok((await this.describe([r]))[0]);
  }

  async list(shopId: string) {
    const rows = await this.db.inboundRequest.findMany({
      where: { shopId },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { items: await this.describe(rows) };
  }

  private async describe(
    rows: Array<{
      id: string;
      warehouseId: string;
      reference: string;
      status: string;
      createdAt: Date;
      lines: { skuId: string; expectedQty: number }[];
    }>,
  ) {
    const receiptIds = await this.db.receipt.findMany({
      where: { inboundId: { in: rows.map((r) => r.id) } },
    });
    const disc = await this.db.receiptDiscrepancy.findMany({
      where: { receiptId: { in: receiptIds.map((r) => r.id) } },
    });
    const skuIds = [
      ...new Set([...rows.flatMap((r) => r.lines.map((l) => l.skuId)), ...disc.map((d) => d.skuId)]),
    ];
    const code = new Map(
      (await this.db.sku.findMany({ where: { id: { in: skuIds } } })).map((s) => [s.id, s.code]),
    );
    return rows.map((r) => ({
      id: r.id,
      warehouseId: r.warehouseId,
      reference: r.reference,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      lines: r.lines.map((l) => ({
        skuId: l.skuId,
        skuCode: code.get(l.skuId) ?? '',
        expectedQty: l.expectedQty,
      })),
      discrepancies: disc
        .filter((d) => receiptIds.some((x) => x.id === d.receiptId && x.inboundId === r.id))
        .map((d) => ({
          skuId: d.skuId,
          skuCode: code.get(d.skuId) ?? '',
          expectedQty: d.expectedQty,
          receivedQty: d.receivedQty,
        })),
    }));
  }
}
