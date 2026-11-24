import { Module } from '@nestjs/common';
import { ShopStockController, WarehouseStockController } from './stock.controller';
import { StockService } from './stock.service';

@Module({
  controllers: [ShopStockController, WarehouseStockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
