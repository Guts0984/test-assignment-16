import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, StaffAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { warehousesOf, type Principal } from '../../common/auth/principal';
import { unwrap } from '../../common/errors';
import { ApiProtectedErrors, Created, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import { AdminShopsService } from './admin-shops.service';
import { AdminStaffService } from './admin-staff.service';
import { AdminWarehousesService } from './admin-warehouses.service';
import {
  ApiKeyListDto,
  CellListDto,
  CellQueryDto,
  CreateCellsDto,
  CreatedApiKeyDto,
  CreatedCellsDto,
  CreatedShopDto,
  CreateShopDto,
  CreateShopUserDto,
  CreateStaffDto,
  CreateWarehouseDto,
  CreateZoneDto,
  ShopDto,
  ShopListDto,
  ShopUserDto,
  StaffDto,
  StaffListDto,
  UpdateShopDto,
  UpdateStaffDto,
  UpdateWarehouseDto,
  WarehouseDto,
  WarehouseListDto,
  ZoneDto,
} from './dto/admin.dto';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly warehouses: AdminWarehousesService,
    private readonly shops: AdminShopsService,
    private readonly staff: AdminStaffService,
  ) {}

  @Post('warehouses') @AdminOnly() @Created(WarehouseDto) @ApiProtectedErrors(409)
  async createWarehouse(@Body() b: CreateWarehouseDto) {
    return unwrap(await this.warehouses.create(b));
  }

  @Get('warehouses') @AdminOnly() @Ok(WarehouseListDto) @ApiProtectedErrors()
  listWarehouses() {
    return this.warehouses.list('all');
  }

  @Patch('warehouses/:id') @AdminOnly() @Ok(WarehouseDto) @ApiProtectedErrors(404)
  async updateWarehouse(@Param('id', UUID) id: string, @Body() b: UpdateWarehouseDto) {
    return unwrap(await this.warehouses.update(id, b));
  }

  @Post('warehouses/:id/zones') @AdminOnly() @Created(ZoneDto) @ApiProtectedErrors(404, 409)
  async createZone(@Param('id', UUID) id: string, @Body() b: CreateZoneDto) {
    return unwrap(await this.warehouses.createZone(id, b.code, b.name));
  }

  @Post('zones/:zoneId/cells') @AdminOnly() @Created(CreatedCellsDto) @ApiProtectedErrors(404, 409)
  async createCells(@Param('zoneId', UUID) zoneId: string, @Body() b: CreateCellsDto) {
    return unwrap(await this.warehouses.createCells(zoneId, b));
  }

  @Post('shops') @AdminOnly() @Created(CreatedShopDto) @ApiProtectedErrors(409)
  async createShop(@Body() b: CreateShopDto) {
    return unwrap(await this.shops.create(b));
  }

  @Get('shops') @AdminOnly() @Ok(ShopListDto) @ApiProtectedErrors()
  listShops() {
    return this.shops.list();
  }

  @Patch('shops/:id') @AdminOnly() @Ok(ShopDto) @ApiProtectedErrors(404)
  async updateShop(@Param('id', UUID) id: string, @Body() b: UpdateShopDto) {
    return unwrap(await this.shops.update(id, b));
  }

  @Post('shops/:id/api-keys') @AdminOnly() @Created(CreatedApiKeyDto) @ApiProtectedErrors(404)
  async createKey(@Param('id', UUID) id: string) {
    return unwrap(await this.shops.createKey(id, 'admin'));
  }

  @Get('shops/:id/api-keys') @AdminOnly() @Ok(ApiKeyListDto) @ApiProtectedErrors()
  listKeys(@Param('id', UUID) id: string) {
    return this.shops.listKeys(id);
  }

  @Post('shops/:id/api-keys/:keyId/revoke') @HttpCode(200) @AdminOnly() @Ok(ApiKeyListDto) @ApiProtectedErrors(404)
  async revokeKey(@Param('id', UUID) id: string, @Param('keyId', UUID) keyId: string) {
    unwrap(await this.shops.revokeKey(id, keyId));
    return this.shops.listKeys(id);
  }

  @Post('shops/:id/users') @AdminOnly() @Created(ShopUserDto) @ApiProtectedErrors(404, 409)
  async createShopUser(@Param('id', UUID) id: string, @Body() b: CreateShopUserDto) {
    return unwrap(await this.shops.createUser(id, b));
  }

  @Post('staff') @AdminOnly() @Created(StaffDto) @ApiProtectedErrors(409)
  async createStaff(@Body() b: CreateStaffDto) {
    return unwrap(await this.staff.create(b));
  }

  @Get('staff') @AdminOnly() @Ok(StaffListDto) @ApiProtectedErrors()
  listStaff() {
    return this.staff.list();
  }

  @Patch('staff/:id') @AdminOnly() @Ok(StaffDto) @ApiProtectedErrors(404)
  async updateStaff(@Param('id', UUID) id: string, @Body() b: UpdateStaffDto) {
    return unwrap(await this.staff.update(id, b));
  }
}

/** Staff-facing warehouse reads, limited to the caller's own warehouses. */
@ApiTags('warehouses')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: AdminWarehousesService) {}

  @Get() @StaffAccess([]) @Ok(WarehouseListDto) @ApiProtectedErrors()
  mine(@CurrentPrincipal() p: Principal) {
    return this.warehouses.list(warehousesOf(p));
  }

  @Get(':warehouseId/cells')
  @StaffAccess(['shift_lead', 'storekeeper', 'picker', 'packer'], 'warehouseId')
  @Ok(CellListDto)
  @ApiProtectedErrors()
  cells(@Param('warehouseId', UUID) warehouseId: string, @Query() q: CellQueryDto) {
    return this.warehouses.cells(warehouseId, q);
  }
}
