import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { approveCount, countView, createCounts, submitCount } from '@ff/core/floor/counts';
import { StaffAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { type StaffPrincipal } from '../../common/auth/principal';
import { httpError, unwrap } from '../../common/errors';
import { ApiProtectedErrors, Created, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import {
  ApproveCountDto,
  CountContentsDto,
  CountDto,
  CountListDto,
  CountQueryDto,
  CountsCreatedDto,
  CreateCountDto,
  SubmitCountDto,
} from './dto/floor.dto';
import { FloorService } from './floor.service';
import { isLeadAt, LEAD, STORE } from './roles';

@ApiTags('counts')
@Controller('warehouses/:warehouseId/counts')
export class CountsController {
  constructor(private readonly floor: FloorService) {}

  @Post()
  @StaffAccess(LEAD, 'warehouseId')
  @Created(CountsCreatedDto)
  @ApiProtectedErrors(404, 409)
  async create(
    @Param('warehouseId', UUID) wid: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: CreateCountDto,
  ) {
    if (b.assigneeId !== undefined) {
      const ok = await this.floor.db.staffRoleAssignment.count({
        where: { staffId: b.assigneeId, warehouseId: wid, role: { in: ['storekeeper', 'shift_lead'] } },
      });
      if (ok === 0)
        throw httpError('VALIDATION_FAILED', 'the assignee is not a storekeeper at this warehouse');
    }
    return { ids: unwrap(await this.floor.run((d, fx) => createCounts(d, fx, wid, p.id, b))) };
  }

  @Get()
  @StaffAccess(STORE, 'warehouseId')
  @Ok(CountListDto)
  @ApiProtectedErrors()
  async list(@Param('warehouseId', UUID) wid: string, @Query() q: CountQueryDto) {
    const rows = await this.floor.db.stockCount.findMany({
      where: {
        warehouseId: wid,
        ...(q.status === undefined ? { status: { not: 'closed' } } : { status: q.status }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const cells = new Map(
      (await this.floor.db.location.findMany({ where: { id: { in: rows.map((r) => r.locationId) } } })).map(
        (c) => [c.id, c.code],
      ),
    );
    return {
      items: rows.map((c) => ({
        id: c.id,
        warehouseId: c.warehouseId,
        locationId: c.locationId,
        cellCode: cells.get(c.locationId) ?? '',
        status: c.status,
        origin: c.origin,
        assigneeId: c.assigneeId,
        needsApproval: c.needsApproval,
        approvedBy: c.approvedBy,
      })),
    };
  }

  @Get(':id')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(CountDto)
  @ApiProtectedErrors(404)
  async get(@Param('warehouseId', UUID) wid: string, @Param('id', UUID) id: string) {
    const v = await countView(this.floor.db, id);
    if (v === null || v.warehouseId !== wid) throw httpError('NOT_FOUND', 'count not found');
    return v;
  }

  /** What the system thinks is in the counted cell, to count against. */
  @Get(':id/contents')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(CountContentsDto)
  @ApiProtectedErrors(404)
  async contents(@Param('warehouseId', UUID) wid: string, @Param('id', UUID) id: string) {
    const c = await this.floor.db.stockCount.findFirst({ where: { id, warehouseId: wid } });
    if (c === null) throw httpError('NOT_FOUND', 'count not found');
    const rows = await this.floor.db.$queryRaw<
      {
        sku_id: string;
        code: string;
        name: string;
        barcode: string;
        batch_id: string;
        batch_code: string;
        expires_on: string | null;
        on_hand: number;
      }[]
    >`SELECT b.sku_id, s.code, s.name, s.barcode, b.batch_id, bt.code AS batch_code, bt.expires_on::text AS expires_on, b.on_hand
      FROM stock_balances b JOIN skus s ON s.id = b.sku_id JOIN batches bt ON bt.id = b.batch_id
      WHERE b.location_id = ${c.locationId}::uuid AND b.on_hand > 0 ORDER BY s.code, bt.code`;
    return {
      items: rows.map((r) => ({
        skuId: r.sku_id,
        skuCode: r.code,
        skuName: r.name,
        barcode: r.barcode,
        batchId: r.batch_id,
        batchCode: r.batch_code,
        expiresOn: r.expires_on,
        systemQty: r.on_hand,
      })),
    };
  }

  /** The assigned storekeeper (or a shift lead) submits what is in the cell. */
  @Post(':id/submit')
  @HttpCode(200)
  @StaffAccess(STORE, 'warehouseId')
  @Ok(CountDto)
  @ApiProtectedErrors(404, 409, 422)
  async submit(
    @Param('warehouseId', UUID) wid: string,
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: SubmitCountDto,
  ) {
    const c = await this.floor.db.stockCount.findFirst({ where: { id, warehouseId: wid } });
    if (c === null) throw httpError('NOT_FOUND', 'count not found');
    if (!isLeadAt(p, wid) && c.assigneeId !== p.id)
      throw httpError('FORBIDDEN', 'this count is assigned to someone else');
    return unwrap(await this.floor.run((d, fx) => submitCount(d, fx, id, p.id, b)));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @StaffAccess(LEAD, 'warehouseId')
  @Ok(CountDto)
  @ApiProtectedErrors(404, 422)
  async approve(
    @Param('warehouseId', UUID) wid: string,
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: ApproveCountDto,
  ) {
    if ((await this.floor.db.stockCount.count({ where: { id, warehouseId: wid } })) === 0)
      throw httpError('NOT_FOUND', 'count not found');
    return unwrap(await this.floor.run((d, fx) => approveCount(d, fx, id, p.id, b.approve)));
  }
}
