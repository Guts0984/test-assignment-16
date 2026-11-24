import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import { cancelOrder, packOrder, shipOrders } from '@ff/core/floor/outbound';
import { AdminOnly, ShopAccess, StaffAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import {
  type ApiKeyPrincipal,
  type ShopUserPrincipal,
  type StaffPrincipal,
} from '../../common/auth/principal';
import { httpError, unwrap } from '../../common/errors';
import { ApiProtectedErrors, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import { labelFileName, renderLabel } from '../../infra/label';
import { CancelDto, CancelResultDto, PackDto, PackResultDto, ShipDto, ShipResultDto } from './dto/floor.dto';
import { FloorService } from './floor.service';
import { actingAs, PACK, STORE } from './roles';

const sendLabel = async (
  floor: FloorService,
  orderId: string,
  scope: { shopId?: string; warehouseId?: string },
  res: Response,
) => {
  const o = await floor.db.order.findUnique({ where: { id: orderId } });
  if (
    o === null ||
    (scope.shopId !== undefined && o.shopId !== scope.shopId) ||
    (scope.warehouseId !== undefined && o.warehouseId !== scope.warehouseId)
  ) {
    throw httpError('NOT_FOUND', 'order not found');
  }
  if (o.shipDay === null || o.warehouseId === null)
    throw httpError('INVALID_TRANSITION', 'the label exists once the order is packed');
  const [shop, wh] = await Promise.all([
    floor.db.shop.findUnique({ where: { id: o.shopId } }),
    floor.db.warehouse.findUnique({ where: { id: o.warehouseId } }),
  ]);
  const pdf = await renderLabel({
    orderId: o.id,
    orderNumber: o.externalNumber,
    shopName: shop?.name ?? '',
    deliveryMethod: o.deliveryMethod,
    warehouseCode: wh?.code ?? '',
    shipDay: o.shipDay.toISOString().slice(0, 10),
    address: o.address as Record<string, unknown>,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${labelFileName(o.id)}"`);
  res.send(pdf);
};

@ApiTags('packing')
@Controller('warehouses/:warehouseId')
export class OutboundController {
  constructor(private readonly floor: FloorService) {}

  @Post('packing')
  @HttpCode(200)
  @StaffAccess(PACK, 'warehouseId')
  @Ok(PackResultDto)
  @ApiProtectedErrors(404, 409, 422)
  async pack(
    @Param('warehouseId', UUID) wid: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: PackDto,
  ) {
    const r = unwrap(
      await this.floor.run((d, fx) =>
        packOrder(d, fx, wid, p.id, actingAs(p, wid, 'packer', 'shift_lead'), b.orderRef, b.idempotencyKey),
      ),
    );
    return { ...r, labelUrl: `/api/warehouses/${wid}/orders/${r.orderId}/label` };
  }

  @Get('orders/:id/label')
  @StaffAccess(PACK, 'warehouseId')
  @ApiProduces('application/pdf')
  @ApiProtectedErrors(404, 422)
  async label(@Param('warehouseId', UUID) wid: string, @Param('id', UUID) id: string, @Res() res: Response) {
    await sendLabel(this.floor, id, { warehouseId: wid }, res);
  }

  @Post('shipments')
  @HttpCode(200)
  @StaffAccess(STORE, 'warehouseId')
  @Ok(ShipResultDto)
  @ApiProtectedErrors()
  async ship(
    @Param('warehouseId', UUID) wid: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: ShipDto,
  ) {
    return unwrap(
      await this.floor.run((d, fx) =>
        shipOrders(d, fx, wid, p.id, actingAs(p, wid, 'storekeeper', 'shift_lead'), b.orderIds),
      ),
    );
  }
}

@ApiTags('shop')
@Controller('shop/v1/orders')
export class ShopOutboundController {
  constructor(private readonly floor: FloorService) {}

  @Post(':id/cancel')
  @HttpCode(200)
  @ShopAccess()
  @Ok(CancelResultDto)
  @ApiProtectedErrors(404, 422)
  async cancel(
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: ShopUserPrincipal | ApiKeyPrincipal,
    @Body() _b: CancelDto,
  ) {
    return unwrap(
      await this.floor.run((d, fx) =>
        cancelOrder(d, fx, id, { type: 'shop', id: null, role: 'shop' }, p.shopId),
      ),
    );
  }

  @Get(':id/label')
  @ShopAccess()
  @ApiProduces('application/pdf')
  @ApiProtectedErrors(404, 422)
  async label(
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: ShopUserPrincipal | ApiKeyPrincipal,
    @Res() res: Response,
  ) {
    await sendLabel(this.floor, id, { shopId: p.shopId }, res);
  }
}

@ApiTags('admin')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly floor: FloorService) {}

  @Post(':id/cancel')
  @HttpCode(200)
  @AdminOnly()
  @Ok(CancelResultDto)
  @ApiProtectedErrors(404, 422)
  async cancel(@Param('id', UUID) id: string, @CurrentPrincipal() p: StaffPrincipal, @Body() _b: CancelDto) {
    return unwrap(
      await this.floor.run((d, fx) =>
        cancelOrder(d, fx, id, { type: 'staff', id: p.id, role: 'admin' }, null),
      ),
    );
  }
}
