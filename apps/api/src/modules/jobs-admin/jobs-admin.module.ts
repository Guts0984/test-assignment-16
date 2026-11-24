import { Module } from '@nestjs/common';
import { JobsAdminController } from './jobs-admin.controller';

@Module({ controllers: [JobsAdminController] })
export class JobsAdminModule {}
