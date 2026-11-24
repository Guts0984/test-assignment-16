import { Module } from '@nestjs/common';
import { AdminController, WarehousesController } from './admin.controller';
import { AdminShopsService } from './admin-shops.service';
import { AdminStaffService } from './admin-staff.service';
import { AdminWarehousesService } from './admin-warehouses.service';

@Module({
  controllers: [AdminController, WarehousesController],
  providers: [AdminWarehousesService, AdminShopsService, AdminStaffService],
})
export class AdminModule {}
