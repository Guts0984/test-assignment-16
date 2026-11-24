import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import { ShopAccess, StaffAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import {
  warehousesOf,
  type ApiKeyPrincipal,
  type Principal,
  type ShopUserPrincipal,
} from '../../common/auth/principal';
import { httpError, unwrap } from '../../common/errors';
import { ApiProtectedErrors, Created, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import {
  BatchAcceptedDto,
  BatchImportDto,
  CreateOrderDto,
  ImportBatchDto,
  ImportResultDto,
  OrderDetailDto,
  OrderPageDto,
  OrderSearchDto,
} from './dto/orders.dto';
import { OrdersService } from './orders.service';

type ShopPrincipal = ShopUserPrincipal | ApiKeyPrincipal;

@ApiTags('shop')
@Controller('shop/v1')
export class ShopOrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** 201 when created, 200 when the same order was already imported (idempotent). */
  @Post('orders')
  @ShopAccess()
  @Created(ImportResultDto)
  @Ok(ImportResultDto)
  @ApiProtectedErrors(409, 422)
  async create(
    @CurrentPrincipal() p: ShopPrincipal,
    @Body() b: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = unwrap(await this.orders.import(p.shopId, b));
    res.status(r.created ? 201 : 200);
    return r;
  }

  @Post('orders/batch')
  @HttpCode(202)
  @ShopAccess()
  @Created(BatchAcceptedDto)
  @ApiProtectedErrors()
  importBatch(@CurrentPrincipal() p: ShopPrincipal, @Body() b: BatchImportDto) {
    return this.orders.importBatch(p.shopId, b);
  }

  @Get('imports/:id')
  @ShopAccess()
  @Ok(ImportBatchDto)
  @ApiProtectedErrors(404)
  async batch(@CurrentPrincipal() p: ShopPrincipal, @Param('id', UUID) id: string) {
    return unwrap(await this.orders.batch(p.shopId, id));
  }

  @Get('orders')
  @ShopAccess()
  @Ok(OrderPageDto)
  @ApiProtectedErrors()
  async list(@CurrentPrincipal() p: ShopPrincipal, @Query() q: OrderSearchDto) {
    if (q.shopId !== undefined && q.shopId !== p.shopId)
      throw httpError('FORBIDDEN', 'shops see only their own orders');
    return unwrap(await this.orders.search({ ...q, shopId: p.shopId, warehouseIds: null }));
  }

  @Get('orders/:id')
  @ShopAccess()
  @Ok(OrderDetailDto)
  @ApiProtectedErrors(404)
  async get(@CurrentPrincipal() p: ShopPrincipal, @Param('id', UUID) id: string) {
    return unwrap(await this.orders.detail(id, { shopId: p.shopId, warehouseIds: null }));
  }
}

@ApiTags('orders')
@Controller('orders')
export class StaffOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @StaffAccess([])
  @Ok(OrderPageDto)
  @ApiProtectedErrors()
  async search(@CurrentPrincipal() p: Principal, @Query() q: OrderSearchDto) {
    const mine = warehousesOf(p);
    if (q.warehouseId !== undefined && mine !== 'all' && !mine.includes(q.warehouseId)) {
      throw httpError('FORBIDDEN', 'not your warehouse');
    }
    const warehouseIds = q.warehouseId !== undefined ? [q.warehouseId] : mine === 'all' ? null : mine;
    return unwrap(await this.orders.search({ ...q, warehouseIds }));
  }

  @Get(':id')
  @StaffAccess([])
  @Ok(OrderDetailDto)
  @ApiProtectedErrors(404)
  async get(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    const mine = warehousesOf(p);
    return unwrap(await this.orders.detail(id, { warehouseIds: mine === 'all' ? null : mine }));
  }
}
