// Builds the HTTP application exactly as production runs it (also used by tests and the
// OpenAPI export). Order matters: request context -> per-IP limit -> content type -> body.
import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ipRateLimit, jsonBody, requestContext, requireJson } from './common/middlewares';
import { type RateLimiter } from './common/rate-limit/limiter';
import { type TrustedProxies } from './common/client-ip';
import { apiEnv, type ApiEnv } from './config/env';
import { LIMITER, REDIS, TRUSTED_PROXIES } from './infra/tokens';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';
import { type Redis } from 'ioredis';

type Operation = { parameters?: { name: string; in: string }[] };

/** Every `{param}` in a path must be a declared path parameter (some are only read by guards). */
export const withPathParams = (doc: OpenAPIObject): OpenAPIObject => {
  for (const [path, item] of Object.entries(doc.paths)) {
    const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
    for (const op of Object.values(item as Record<string, Operation>)) {
      if (typeof op !== 'object' || op === null) continue;
      const have = new Set((op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name));
      const missing = names.filter((n) => !have.has(n));
      if (missing.length > 0) {
        op.parameters = [
          ...(op.parameters ?? []),
          ...missing.map((name) => ({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          })),
        ] as never;
      }
    }
  }
  return doc;
};

export const buildOpenApi = (app: INestApplication): OpenAPIObject =>
  withPathParams(
    cleanupOpenApiDoc(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('Fulfillment API')
          .setDescription('Warehouse fulfillment for online shops. Every error uses the shared error body.')
          .setVersion('1.0.0')
          .addBearerAuth({
            type: 'http',
            scheme: 'bearer',
            description: 'Staff/shop JWT or shop API key (fk_...)',
          })
          .build(),
      ),
    ),
  );

export const createApp = async (env: ApiEnv = apiEnv()): Promise<NestExpressApplication> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    bodyParser: false,
    logger:
      env.LOG_LEVEL === 'silent'
        ? false
        : [
            'error',
            'warn',
            ...(env.LOG_LEVEL === 'info' || env.LOG_LEVEL === 'debug' ? (['log'] as const) : []),
          ],
  });
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const trusted = app.get<TrustedProxies>(TRUSTED_PROXIES);
  const { limiter } = app.get<{ limiter: RateLimiter }>(LIMITER);
  app.use(requestContext(trusted));
  app.use(ipRateLimit(limiter, env.RATE_LIMIT_GENERAL_PER_IP, env.RATE_LIMIT_ENABLED));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(requireJson);
  app.use(jsonBody(env.BODY_LIMIT_BYTES));
  app.use(cookieParser());
  const origins = new Set(
    env.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  app.enableCors({ origin: (o, cb) => cb(null, o !== undefined && origins.has(o)), credentials: true });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  const redis = app.get<Redis>(REDIS);
  app.useWebSocketAdapter(new RedisIoAdapter(app, redis.duplicate(), redis.duplicate()));
  app.enableShutdownHooks();
  SwaggerModule.setup('docs', app, buildOpenApi(app));
  return app;
};

export const listen = async (app: INestApplication, port: number): Promise<void> => {
  const server = app.getHttpServer() as import('node:http').Server;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  await app.listen(port, '0.0.0.0');
  new Logger('bootstrap').log(`api listening on ${port}`);
};
