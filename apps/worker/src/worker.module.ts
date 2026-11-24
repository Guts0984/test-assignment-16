import { Module } from '@nestjs/common';
import { JobsProcessor } from './jobs.processor';
import { type Runtime } from './infra/deps';

export const RUNTIME = Symbol('RUNTIME');

@Module({})
export class WorkerModule {
  static register(rt: Runtime) {
    return {
      module: WorkerModule,
      providers: [
        { provide: RUNTIME, useValue: rt },
        { provide: JobsProcessor, useFactory: () => new JobsProcessor(rt) },
      ],
    };
  }
}
