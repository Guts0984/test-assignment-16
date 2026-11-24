import { Module } from '@nestjs/common';
import { CountsController } from './counts.controller';
import { FloorService } from './floor.service';
import { LeadController } from './lead.controller';
import { AdminOrdersController, OutboundController, ShopOutboundController } from './outbound.controller';
import { PickingController } from './picking.controller';
import { StockOpsController } from './stock-ops.controller';

@Module({
  controllers: [
    StockOpsController,
    PickingController,
    OutboundController,
    ShopOutboundController,
    AdminOrdersController,
    CountsController,
    LeadController,
  ],
  providers: [FloorService],
  exports: [FloorService],
})
export class FloorModule {}
