import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShopAccess, StaffAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { type ApiKeyPrincipal, type ShopUserPrincipal } from '../../common/auth/principal';
import { ApiProtectedErrors, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import { StaffStockQueryDto, StockPageDto, StockQueryDto } from './dto/stock.dto';
import { StockService } from './stock.service';

@ApiTags('shop')
@Controller('shop/v1/stock')
export class ShopStockController {
  constructor(private readonly stock: StockService) {}

  @Get()
  @ShopAccess()
  @Ok(StockPageDto)
  @ApiProtectedErrors()
  list(@CurrentPrincipal() p: ShopUserPrincipal | ApiKeyPrincipal, @Query() q: StockQueryDto) {
    return this.stock.shopStock(p.shopId, q);
  }
}

@ApiTags('warehouses')
@Controller('warehouses/:warehouseId/stock')
export class WarehouseStockController {
  constructor(private readonly stock: StockService) {}

  @Get()
  @StaffAccess(['shift_lead', 'storekeeper', 'picker', 'packer'], 'warehouseId')
  @Ok(StockPageDto)
  @ApiProtectedErrors()
  get(@Param('warehouseId', UUID) warehouseId: string, @Query() q: StaffStockQueryDto) {
    return this.stock.warehouseStock(warehouseId, q.sku);
  }
}
