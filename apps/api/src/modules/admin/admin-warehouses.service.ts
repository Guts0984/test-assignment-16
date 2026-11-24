import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@ff/db/client';
import { pgCode, SQLSTATE } from '@ff/db/pg-errors';
import { fail, ok, type Result } from '@ff/shared/result';
import { type CreateCellsInput, type CreateWarehouseInput } from '@ff/shared/schemas/setup';
import { DB } from '../../infra/tokens';
import { toCell, toWarehouse } from './domain/mappers';
import { decodeCursor, encodeCursor } from '@ff/core/stock/view';

const VIRTUAL = ['receiving', 'packing', 'return'] as const;

@Injectable()
export class AdminWarehousesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(input: CreateWarehouseInput): Promise<Result<ReturnType<typeof toWarehouse>>> {
    try {
      const w = await this.db.$transaction(async (tx) => {
        const created = await tx.warehouse.create({
          data: { ...input, lat: input.lat ?? null, lon: input.lon ?? null },
        });
        await tx.location.createMany({
          data: VIRTUAL.map((kind) => ({
            warehouseId: created.id,
            kind,
            code: kind.toUpperCase(),
            walkOrder: 0,
          })),
        });
        return created;
      });
      return ok(toWarehouse(w));
    } catch (e) {
      if (pgCode(e) === SQLSTATE.uniqueViolation)
        return fail('DUPLICATE_CODE', 'warehouse code already exists');
      throw e;
    }
  }

  async update(
    id: string,
    patch: Partial<CreateWarehouseInput>,
  ): Promise<Result<ReturnType<typeof toWarehouse>>> {
    if ((await this.db.warehouse.count({ where: { id } })) === 0)
      return fail('NOT_FOUND', 'warehouse not found');
    await this.db.warehouse.updateMany({ where: { id }, data: patch });
    return ok(toWarehouse(await this.db.warehouse.findUniqueOrThrow({ where: { id } })));
  }

  async list(ids: readonly string[] | 'all') {
    const rows = await this.db.warehouse.findMany({
      where: ids === 'all' ? {} : { id: { in: [...ids] } },
      orderBy: { code: 'asc' },
    });
    return { items: rows.map(toWarehouse) };
  }

  async createZone(
    warehouseId: string,
    code: string,
    name: string,
  ): Promise<Result<{ id: string; warehouseId: string; code: string; name: string }>> {
    if ((await this.db.warehouse.count({ where: { id: warehouseId } })) === 0)
      return fail('NOT_FOUND', 'warehouse not found');
    try {
      const z = await this.db.zone.create({ data: { warehouseId, code, name } });
      return ok({ id: z.id, warehouseId: z.warehouseId, code: z.code, name: z.name });
    } catch (e) {
      if (pgCode(e) === SQLSTATE.uniqueViolation)
        return fail('DUPLICATE_CODE', 'zone code already exists in this warehouse');
      throw e;
    }
  }

  async createCells(zoneId: string, input: CreateCellsInput): Promise<Result<{ created: number }>> {
    const zone = await this.db.zone.findUnique({ where: { id: zoneId } });
    if (zone === null) return fail('NOT_FOUND', 'zone not found');
    try {
      const r = await this.db.location.createMany({
        data: input.cells.map((c) => ({
          warehouseId: zone.warehouseId,
          zoneId,
          kind: 'storage' as const,
          code: c.code,
          walkOrder: c.walkOrder,
          capacityVolumeCm3: BigInt(c.capacityVolumeCm3),
          capacityWeightG: BigInt(c.capacityWeightG),
        })),
      });
      return ok({ created: r.count });
    } catch (e) {
      if (pgCode(e) === SQLSTATE.uniqueViolation)
        return fail('DUPLICATE_CODE', 'a cell code already exists in this warehouse');
      throw e;
    }
  }

  async cells(warehouseId: string, q: { code?: string; limit: number; cursor?: string }) {
    const after = decodeCursor(q.cursor, 1)?.[0];
    const rows = await this.db.location.findMany({
      where: {
        warehouseId,
        ...(q.code === undefined ? {} : { code: { startsWith: q.code.toUpperCase() } }),
        ...(after === undefined ? {} : { code: { gt: after } }),
      },
      orderBy: { code: 'asc' },
      take: q.limit + 1,
    });
    const items = rows.slice(0, q.limit).map(toCell);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > q.limit && last !== undefined ? encodeCursor([last.code]) : null,
    };
  }
}
