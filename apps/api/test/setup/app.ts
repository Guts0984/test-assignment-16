// Boots the real Nest app in-process on an ephemeral port with the production middleware stack.
import { type AddressInfo } from 'node:net';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { createDb, type Db } from '@ff/db/client';
import { createApp } from '../../src/bootstrap';
import { parseApiEnv } from '../../src/config/env';
import { rawEnv } from './test-env';

export type TestApp = { readonly app: NestExpressApplication; readonly base: string; readonly db: Db; readonly close: () => Promise<void> };

export const startTestApp = async (overrides: Record<string, string> = {}): Promise<TestApp> => {
  const env = parseApiEnv({ ...rawEnv(), LOG_LEVEL: rawEnv().TEST_LOG_LEVEL ?? 'silent', NODE_ENV: 'test', ...overrides });
  const app = await createApp(env);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const db = createDb({ url: env.DATABASE_URL, poolSize: 5 });
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    db,
    close: async () => {
      await db.$disconnect();
      await app.close();
    },
  };
};

export type Res<T = unknown> = { readonly status: number; readonly body: T; readonly headers: Headers };

export const http = (base: string) => {
  const call = async <T = any>(method: string, path: string, o: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res<T>> => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token !== undefined) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined || o.raw !== undefined) headers['content-type'] ??= 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : o.raw !== undefined ? { body: o.raw } : {}),
    });
    const text = await res.text();
    const body = (() => {
      try {
        return text === '' ? null : JSON.parse(text);
      } catch {
        return text;
      }
    })();
    return { status: res.status, body: body as T, headers: res.headers };
  };
  return {
    get: <T = any>(p: string, o?: { token?: string; headers?: Record<string, string> }) => call<T>('GET', p, o),
    post: <T = any>(p: string, body?: unknown, o?: { token?: string; headers?: Record<string, string>; raw?: string }) =>
      call<T>('POST', p, { ...o, ...(body === undefined ? {} : { body }) }),
    patch: <T = any>(p: string, body: unknown, o?: { token?: string }) => call<T>('PATCH', p, { ...o, body }),
    call,
  };
};
