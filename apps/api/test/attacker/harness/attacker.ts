// The attacker toolkit: real network clients with chosen source IPs, bursts with a start barrier,
// slow and malformed requests, sockets that record events, worker and Redis control, the ledger
// check and the shared test clock.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { Redis } from 'ioredis';
import { io as connect, type Socket } from 'socket.io-client';
import { isBalanced, ledgerReport } from '@ff/db/ledger';
import { getStack } from './global';

export type Auth = { readonly bearer?: string } | undefined;
export type Res<T = any> = {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: T;
  readonly text: string;
  readonly ms: number;
};

type Opts = {
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly timeoutMs?: number;
};

export const request = (
  base: string,
  method: string,
  path: string,
  sourceIp: string | undefined,
  auth: Auth,
  o: Opts = {},
): Promise<Res> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const u = new URL(path, base);
    const payload = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (auth?.bearer !== undefined) headers.authorization = `Bearer ${auth.bearer}`;
    if (payload !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(payload));
      headers['content-type'] ??= 'application/json';
    }
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
        agent: false,
        timeout: o.timeoutMs ?? 30_000,
        ...(sourceIp === undefined ? {} : { localAddress: sourceIp }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = text === '' ? null : JSON.parse(text);
          } catch {
            // not JSON: keep text
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text,
            ms: Date.now() - started,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(payload);
  });

export type Client = {
  readonly get: <T = any>(p: string, o?: Opts) => Promise<Res<T>>;
  readonly post: <T = any>(p: string, body?: unknown, o?: Opts) => Promise<Res<T>>;
  readonly patch: <T = any>(p: string, body?: unknown, o?: Opts) => Promise<Res<T>>;
  readonly call: <T = any>(m: string, p: string, o?: Opts) => Promise<Res<T>>;
  readonly withAuth: (bearer: string | undefined) => Client;
  readonly sourceIp: string | undefined;
};

const mk = (base: string, sourceIp: string | undefined, auth: Auth): Client => ({
  get: (p, o) => request(base, 'GET', p, sourceIp, auth, o),
  post: (p, body, o) =>
    request(base, 'POST', p, sourceIp, auth, { ...o, ...(body === undefined ? {} : { body }) }),
  patch: (p, body, o) =>
    request(base, 'PATCH', p, sourceIp, auth, { ...o, ...(body === undefined ? {} : { body }) }),
  call: (m, p, o) => request(base, m, p, sourceIp, auth, o),
  withAuth: (bearer) => mk(base, sourceIp, bearer === undefined ? undefined : { bearer }),
  sourceIp,
});

/** A client through nginx with its own source IP (all of 127.0.0.0/8 is loopback on Linux). */
export const client = (o: { sourceIp?: string; auth?: string | undefined } = {}): Client =>
  mk(getStack().nginx, o.sourceIp, o.auth === undefined ? undefined : { bearer: o.auth });

/** One api copy directly, bypassing nginx. */
export const apiCopy = (which: 'a' | 'b', o: { sourceIp?: string; auth?: string | undefined } = {}): Client =>
  mk(
    which === 'a' ? getStack().apiA : getStack().apiB,
    o.sourceIp,
    o.auth === undefined ? undefined : { bearer: o.auth },
  );

/** Runs `n` calls truly in parallel: every call is prepared, then all are released together. */
export function burst<T>(n: 2, fn: (i: number) => Promise<T>): Promise<[T, T]>;
export function burst<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]>;
export async function burst<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const gate = { open: () => undefined as void };
  const barrier = new Promise<void>((r) => (gate.open = r));
  const runs = Array.from({ length: n }, async (_, i) => {
    await barrier;
    return fn(i);
  });
  await new Promise((r) => setTimeout(r, 50));
  gate.open();
  return Promise.all(runs);
}

export const flood = (n: number, fn: (i: number) => Promise<Res>, concurrency = 50): Promise<Res[]> => {
  const out: Res[] = [];
  const next = { i: 0 };
  const worker = async (): Promise<void> => {
    while (next.i < n) {
      const i = next.i++;
      out[i] = await fn(i).catch((e: Error) => ({
        status: 0,
        headers: {},
        body: e.message,
        text: e.message,
        ms: 0,
      }));
    }
  };
  return Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker)).then(() => out);
};

/** Opens a connection and sends bytes with long pauses (slowloris style); resolves when closed or after `holdMs`. */
export const slowRequest = (
  base: string,
  holdMs: number,
  sourceIp?: string,
): Promise<{ closedEarly: boolean }> =>
  new Promise((resolve) => {
    const u = new URL(base);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: '/api/health',
      method: 'POST',
      headers: { 'content-length': '1000' },
      agent: false,
      ...(sourceIp === undefined ? {} : { localAddress: sourceIp }),
    });
    req.on('error', () => resolve({ closedEarly: true }));
    req.on('close', () => resolve({ closedEarly: true }));
    req.write('x');
    setTimeout(() => {
      req.destroy();
      resolve({ closedEarly: false });
    }, holdMs).unref();
  });

/** Raw bytes on a TCP connection (malformed requests); resolves with whatever the server answers. */
export const raw = (base: string, bytes: string, sourceIp?: string): Promise<string> =>
  new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- net is only needed here
    const net = require('node:net') as typeof import('node:net');
    const u = new URL(base);
    const s = net.connect({
      host: u.hostname,
      port: Number(u.port),
      ...(sourceIp === undefined ? {} : { localAddress: sourceIp }),
    });
    const chunks: Buffer[] = [];
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    s.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
    s.write(bytes);
    setTimeout(() => s.destroy(), 1500).unref();
  });

export type Recorded = { readonly event: string; readonly at: number; readonly payload: any };
export type RecordingSocket = {
  readonly s: Socket;
  readonly events: Recorded[];
  readonly ready: () => boolean;
  readonly close: () => void;
};

export const socket = async (o: {
  auth?: string | undefined;
  apiCopy?: 'a' | 'b' | 'nginx';
  sourceIp?: string;
}): Promise<RecordingSocket> => {
  const st = getStack();
  const url = o.apiCopy === 'a' ? st.apiA : o.apiCopy === 'b' ? st.apiB : st.nginx;
  const s = connect(url, {
    transports: ['websocket'],
    auth: o.auth === undefined ? {} : { token: o.auth },
    reconnection: false,
    ...(o.sourceIp === undefined ? {} : { localAddress: o.sourceIp }),
  } as never);
  const events: Recorded[] = [];
  s.onAny((event, payload) => events.push({ event, at: Date.now(), payload }));
  await new Promise<void>((res) => {
    s.on('ready', () => res());
    s.on('disconnect', () => res());
    s.on('connect_error', () => res());
    setTimeout(res, 4000).unref();
  });
  return { s, events, ready: () => events.some((e) => e.event === 'ready'), close: () => void s.close() };
};

export const until = async (
  cond: () => boolean | Promise<boolean>,
  ms = 20_000,
  every = 50,
): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, every));
  }
};

export const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
};

export const percentile = (xs: readonly number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};

export const ledger = {
  /** Current stock equals the ledger sum everywhere; nothing is negative; reserved never exceeds on-hand. */
  assertBalanced: async (): Promise<void> => {
    const r = await ledgerReport(getStack().db);
    if (!isBalanced(r)) throw new Error(`ledger out of balance: ${JSON.stringify(r)}`);
  },
};

export const workers = {
  kill9: (i: number) => getStack().kill9Worker(i),
  start: (i: number, extra?: Record<string, string>) => getStack().startWorker(i, extra),
  restart: async (i: number) => {
    await getStack().kill9Worker(i);
    await getStack().startWorker(i);
  },
  running: () =>
    getStack()
      .workers()
      .filter((w) => w !== null).length,
};

const redisContainer = (): string => getStack().redisContainer;

export const redis = {
  flushAll: async (): Promise<void> => {
    const r = new Redis(getStack().redisUrl);
    await r.flushall();
    r.disconnect();
  },
  /** Stops and starts the Redis container (all Redis data is lost, nothing else is). */
  restart: async (): Promise<void> => {
    execFileSync('docker', ['restart', redisContainer()], { stdio: 'ignore' });
    await until(async () => {
      const r = new Redis(getStack().redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
      try {
        await r.connect();
        return (await r.ping()) === 'PONG';
      } catch {
        return false;
      } finally {
        r.disconnect();
      }
    }, 30_000);
  },
  stop: () => execFileSync('docker', ['stop', redisContainer()], { stdio: 'ignore' }),
  start: () => execFileSync('docker', ['start', redisContainer()], { stdio: 'ignore' }),
  keys: async (pattern: string): Promise<string[]> => {
    const r = new Redis(getStack().redisUrl);
    const k = await r.keys(pattern);
    r.disconnect();
    return k;
  },
  ttl: async (key: string): Promise<number> => {
    const r = new Redis(getStack().redisUrl);
    const t = await r.pttl(key);
    r.disconnect();
    return t;
  },
};

/** The shared test clock: every api and worker process reads it (never a real sleep). */
export const clock = {
  advance: async (ms: number) =>
    client().post(
      '/api/test/clock',
      { advanceMs: ms },
      { headers: { 'x-test-token': getStack().controlToken } },
    ),
  set: async (iso: string) =>
    client().post(
      '/api/test/clock',
      { setTo: iso },
      { headers: { 'x-test-token': getStack().controlToken } },
    ),
  reset: async () =>
    client().post(
      '/api/test/clock',
      { reset: true },
      { headers: { 'x-test-token': getStack().controlToken } },
    ),
  now: async (): Promise<number> => Date.parse((await client().get('/api/time')).body.now),
};

/** Element `i` of a list, or a clear failure (tests index into results they have just produced). */
export const at = <T>(xs: readonly T[], i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`expected an element at index ${i} of ${xs.length}`);
  return x;
};

export const must = <T>(x: T | undefined | null, what = 'value'): T => {
  if (x === undefined || x === null) throw new Error(`expected ${what}`);
  return x;
};
