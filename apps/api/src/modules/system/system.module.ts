import { type DynamicModule, Module } from '@nestjs/common';
import { SystemController, TestClockController } from './system.controller';

@Module({})
export class SystemModule {
  static register(testClockEnabled: boolean): DynamicModule {
    return {
      module: SystemModule,
      controllers: testClockEnabled ? [SystemController, TestClockController] : [SystemController],
    };
  }
}
