import { Module } from '@nestjs/common';
import { ShopOrdersController, StaffOrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({ controllers: [ShopOrdersController, StaffOrdersController], providers: [OrdersService], exports: [OrdersService] })
export class OrdersModule {}
