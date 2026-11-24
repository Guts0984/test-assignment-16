import { Module } from '@nestjs/common';
import { AdminWarehousesService } from '../admin/admin-warehouses.service';
import { ShopStockController, ShopWarehousesController, WarehouseStockController } from './stock.controller';
import { StockService } from './stock.service';

@Module({
  controllers: [ShopStockController, WarehouseStockController, ShopWarehousesController],
  providers: [StockService, AdminWarehousesService],
  exports: [StockService],
})
export class StockModule {}
