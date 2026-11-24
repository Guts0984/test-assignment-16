import { type DynamicModule, Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { type ApiEnv } from './config/env';
import { InfraModule } from './infra/infra.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { FloorModule } from './modules/floor/floor.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { InboundModule } from './modules/inbound/inbound.module';
import { OrdersModule } from './modules/orders/orders.module';
import { StockModule } from './modules/stock/stock.module';
import { SystemModule } from './modules/system/system.module';

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.register(env),
        AuthModule,
        AdminModule,
        CatalogModule,
        OrdersModule,
        InboundModule,
        StockModule,
        FloorModule,
        RealtimeModule,
        SystemModule.register(env.TEST_CLOCK_ENABLED),
      ],
      providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
    };
  }
}
