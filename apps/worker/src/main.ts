import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { workerEnv } from './config/env';
import { buildRuntime } from './infra/deps';
import { WorkerModule } from './worker.module';

const main = async (): Promise<void> => {
  const env = workerEnv();
  const rt = await buildRuntime(env);
  const app = await NestFactory.createApplicationContext(WorkerModule.register(rt), {
    logger: env.LOG_LEVEL === 'silent' ? false : ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
  new Logger('worker').log(`ready (${rt.workerId})`);
};

main().catch((e: unknown) => {
  process.stderr.write(`worker failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
