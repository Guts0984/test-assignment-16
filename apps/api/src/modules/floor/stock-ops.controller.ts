import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  addReceiptLine,
  closeReceipt,
  confirmPutaway,
  createReceipt,
  createTransfer,
  moveStock,
  pendingPutaway,
  receiveTransfer,
  suggestPutaway,
} from '@ff/core/floor/inbound';
import { ok } from '@ff/shared/result';
import { StaffAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { type StaffPrincipal } from '../../common/auth/principal';
import { unwrap } from '../../common/errors';
import { ApiProtectedErrors, Created, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import {
  CreateReceiptDto,
  CreateTransferDto,
  IdDto,
  MoveDto,
  PendingPutawayDto,
  PutawayConfirmDto,
  PutawayResultDto,
  PutawaySuggestDto,
  QtyDto,
  ReceiptLineDto,
  ReceiptLineResultDto,
  ReceiptListDto,
  ReceiptSummaryDto,
  ReceiveTransferDto,
  ShopBriefListDto,
  SuggestionsDto,
  TransferCreatedDto,
  TransferListDto,
  TransferReceivedDto,
} from './dto/floor.dto';
import { FloorService } from './floor.service';
import { STORE } from './roles';

@ApiTags('storekeeper')
@Controller('warehouses/:warehouseId')
export class StockOpsController {
  constructor(private readonly floor: FloorService) {}

  /** Shops a storekeeper can receive for (id, code and name only; no webhook settings). */
  @Get('shops')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(ShopBriefListDto)
  @ApiProtectedErrors()
  async shops() {
    const rows = await this.floor.db.shop.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true },
    });
    return { items: rows };
  }

  @Post('receipts')
  @StaffAccess(STORE, 'warehouseId')
  @Created(IdDto)
  @ApiProtectedErrors(404)
  async createReceipt(
    @Param('warehouseId', UUID) wid: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: CreateReceiptDto,
  ) {
    return unwrap(await createReceipt(this.floor.deps, wid, p, b));
  }

  @Get('receipts')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(ReceiptListDto)
  @ApiProtectedErrors()
  async receipts(@Param('warehouseId', UUID) wid: string) {
    const rows = await this.floor.db.receipt.findMany({
      where: { warehouseId: wid, status: 'open' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        shopId: r.shopId,
        inboundId: r.inboundId,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  @Post('receipts/:id/lines')
  @StaffAccess(STORE, 'warehouseId')
  @Created(ReceiptLineResultDto)
  @ApiProtectedErrors(404, 409, 422)
  async addLine(
    @Param('warehouseId', UUID) wid: string,
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: ReceiptLineDto,
  ) {
    return unwrap(await this.floor.run((d, fx) => addReceiptLine(d, fx, wid, id, p, b)));
  }

  @Post('receipts/:id/close')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(ReceiptSummaryDto)
  @ApiProtectedErrors(404)
  async close(@Param('warehouseId', UUID) wid: string, @Param('id', UUID) id: string) {
    return unwrap(await this.floor.run((d, fx) => closeReceipt(d, fx, wid, id)));
  }

  @Get('putaway/pending')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(PendingPutawayDto)
  @ApiProtectedErrors()
  async pending(@Param('warehouseId', UUID) wid: string) {
    const rows = await pendingPutaway(this.floor.deps, wid);
    return {
      items: rows.map((r) => ({
        sourceLocationId: r.location_id,
        kind: r.kind,
        skuId: r.sku_id,
        skuCode: r.sku_code,
        barcode: r.barcode,
        batchId: r.batch_id,
        batchCode: r.batch_code,
        qty: r.qty,
      })),
    };
  }

  @Post('putaway/suggest')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(SuggestionsDto)
  @ApiProtectedErrors(404)
  async suggest(@Param('warehouseId', UUID) wid: string, @Body() b: PutawaySuggestDto) {
    return { items: unwrap(await suggestPutaway(this.floor.deps, wid, b)) };
  }

  @Post('putaway/confirm')
  @StaffAccess(STORE, 'warehouseId')
  @Created(PutawayResultDto)
  @ApiProtectedErrors(404, 409, 422)
  async confirm(
    @Param('warehouseId', UUID) wid: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: PutawayConfirmDto,
  ) {
    return unwrap(await this.floor.run((d, fx) => confirmPutaway(d, fx, wid, p, b)));
  }

  @Post('moves')
  @StaffAccess(STORE, 'warehouseId')
  @Created(QtyDto)
  @ApiProtectedErrors(404, 409, 422)
  async move(
    @Param('warehouseId', UUID) wid: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: MoveDto,
  ) {
    return unwrap(await this.floor.run((d, fx) => moveStock(d, fx, wid, p, b)));
  }

  @Post('transfers')
  @StaffAccess(STORE, 'warehouseId')
  @Created(TransferCreatedDto)
  @ApiProtectedErrors(404, 409, 422)
  async transfer(
    @Param('warehouseId', UUID) wid: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: CreateTransferDto,
  ) {
    return unwrap(await this.floor.run((d, fx) => createTransfer(d, fx, wid, p, b)));
  }

  @Get('transfers')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(TransferListDto)
  @ApiProtectedErrors()
  async transfers(@Param('warehouseId', UUID) wid: string) {
    const ts = await this.floor.db.transfer.findMany({
      where: { OR: [{ fromWarehouseId: wid }, { toWarehouseId: wid }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const lines = await this.floor.db.transferLine.findMany({
      where: { transferId: { in: ts.map((t) => t.id) } },
    });
    return {
      items: ts.map((t) => ({
        id: t.id,
        fromWarehouseId: t.fromWarehouseId,
        toWarehouseId: t.toWarehouseId,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        lines: lines
          .filter((l) => l.transferId === t.id)
          .map((l) => ({ skuId: l.skuId, batchId: l.batchId, qty: l.qty, receivedQty: l.receivedQty })),
      })),
    };
  }

  @Post('transfers/:id/receive')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(TransferReceivedDto)
  @ApiProtectedErrors(404, 409, 422)
  async receive(
    @Param('warehouseId', UUID) wid: string,
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: ReceiveTransferDto,
  ) {
    return unwrap(await this.floor.run((d, fx) => receiveTransfer(d, fx, wid, id, p, b)));
  }

  /** Free stock of one SKU per cell (for moves and transfers). */
  @Get('cells-stock')
  @StaffAccess(STORE, 'warehouseId')
  @Ok(PendingPutawayDto)
  @ApiProtectedErrors()
  async cellsStock(@Param('warehouseId', UUID) wid: string, @Query('sku') sku?: string) {
    const parsed = z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .safeParse(sku);
    if (!parsed.success) return unwrap(ok({ items: [] }));
    const rows = await this.floor.db.$queryRaw<
      {
        location_id: string;
        code: string;
        sku_id: string;
        sku_code: string;
        barcode: string;
        batch_id: string;
        batch_code: string;
        free: number;
      }[]
    >`
      SELECT b.location_id, l.code, b.sku_id, s.code AS sku_code, s.barcode, b.batch_id, bt.code AS batch_code, (b.on_hand - b.reserved) AS free
      FROM stock_balances b JOIN locations l ON l.id = b.location_id JOIN skus s ON s.id = b.sku_id JOIN batches bt ON bt.id = b.batch_id
      WHERE b.warehouse_id = ${wid}::uuid AND l.kind = 'storage' AND (s.barcode = ${parsed.data} OR s.code = ${parsed.data}) AND b.on_hand > 0
      ORDER BY l.walk_order LIMIT 200`;
    return {
      items: rows.map((r) => ({
        sourceLocationId: r.location_id,
        kind: r.code,
        skuId: r.sku_id,
        skuCode: r.sku_code,
        barcode: r.barcode,
        batchId: r.batch_id,
        batchCode: r.batch_code,
        qty: r.free,
      })),
    };
  }
}
