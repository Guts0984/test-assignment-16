// The real stack for adversarial tests, started like production: nginx in front of two api copies,
// three worker processes (killable), the shop stub, real Postgres and Redis (from docker compose).
// Child processes bind loopback; nginx runs with host networking so clients really arrive from
// distinct 127.0.0.N addresses and nginx sees them (the per-IP rate limiter tests depend on it).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb, type Db } from '@ff/db/client';
import { resetTestDatabase } from '@ff/db/testing';

const ROOT = resolve(__dirname, '../../../../..');

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });

export type StackInfo = {
  readonly nginx: string;
  readonly apiA: string;
  readonly apiB: string;
  readonly stub: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** Name of this run's private Redis container. */
  readonly redisContainer: string;
  readonly controlToken: string;
  readonly env: Readonly<Record<string, string>>;
};

export type Stack = StackInfo & {
  readonly db: Db;
  readonly workers: () => readonly (ChildProcess | null)[];
  readonly startWorker: (i: number, extra?: Record<string, string>) => Promise<void>;
  readonly kill9Worker: (i: number) => Promise<void>;
  readonly stopAll: () => Promise<void>;
};

const loadDotEnv = (): Record<string, string> => {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) throw new Error('.env missing: cp .env.example .env');
  const out: Record<string, string> = {};
  for (const line of execFileSync('cat', [file], { encoding: 'utf8' }).split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined) out[m[1]] = m[2] ?? '';
  }
  return out;
};

const waitHttp = async (url: string, ms = 60_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (
      (await fetch(url)
        .then((r) => r.ok)
        .catch(() => false)) === true
    )
      return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
};

export const startStack = async (): Promise<Stack> => {
  const dot = loadDotEnv();
  const dbUrl = (dot.TEST_DATABASE_URL ?? '').replace(/_test$/, '_adv_test');
  await resetTestDatabase(dbUrl);
  const controlToken = 'adversarial-control-token';
  const [pa, pb, ps, pn, pr] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  // A private Redis for this run: the suite flushes, stops and restarts it, which must never touch
  // the developer's live compose Redis.
  const redisContainer = `ff-adv-redis-${process.pid}`;
  const redisUrl = `redis://127.0.0.1:${pr}/0`;
  execFileSync('docker', ['rm', '-f', redisContainer], { stdio: 'ignore' });
  execFileSync('docker', ['run', '-d', '--name', redisContainer, '-p', `127.0.0.1:${pr}:6379`, 'redis:7'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if (
        execFileSync('docker', ['exec', redisContainer, 'redis-cli', 'ping'], { encoding: 'utf8' }).trim() ===
        'PONG'
      )
        break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const base: Record<string, string> = {
    ...dot,
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    DATABASE_URL: dbUrl,
    REDIS_URL: redisUrl,
    TEST_CLOCK_ENABLED: 'true',
    TEST_CONTROL_TOKEN: controlToken,
    SHOP_STUB_CONTROL_ENABLED: 'true',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
    WEBHOOK_ALLOW_PRIVATE_HOSTS: 'true',
    RECONCILE_INTERVAL_MS: '300',
    JOB_LEASE_MS: '4000',
    JOB_BACKOFF_MS: '300',
    WEBHOOK_BACKOFF_MAX_MS: '2000',
    WEBHOOK_TIMEOUT_MS: '1500',
    SOCKET_PRESENCE_TTL_SEC: '3',
    RATE_LIMIT_WINDOW_MS: '8000',
    // the rate-limit specs depend on these exact values
    RATE_LIMIT_LOGIN_PER_IP: '20',
    RATE_LIMIT_LOGIN_PER_ACCOUNT: '10',
    // CI's Postgres allows 100 connections: two api copies and up to three workers must fit with the test's own
    DB_POOL_SIZE: '8',
    REFRESH_REUSE_GRACE_SEC: '0', // the strict single-use specs; the grace window has its own integration test
    WEBHOOK_MAX_ATTEMPTS: '4',
    WEBHOOK_BACKOFF_BASE_MS: '300',
    CORS_ORIGINS: 'http://allowed.example',
  };
  const procs: ChildProcess[] = [];
  const spawnNode = (script: string, env: Record<string, string>): ChildProcess => {
    const p = spawn('node', [join(ROOT, script)], {
      env: { ...process.env, ...base, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    procs.push(p);
    return p;
  };
  const workers: (ChildProcess | null)[] = [null, null, null];
  const startWorker = async (i: number, extra: Record<string, string> = {}): Promise<void> => {
    workers[i] = spawnNode('apps/worker/dist/main.js', { WORKER_ID: `adv-w${i}`, ...extra });
  };
  const kill9Worker = async (i: number): Promise<void> => {
    const w = workers[i];
    if (w === null || w === undefined) return;
    await new Promise<void>((res) => {
      w.once('exit', () => res());
      w.kill('SIGKILL');
    });
    workers[i] = null;
  };

  spawnNode('apps/api/dist/main.js', { API_PORT: String(pa), API_INSTANCE_ID: 'a' });
  spawnNode('apps/api/dist/main.js', { API_PORT: String(pb), API_INSTANCE_ID: 'b' });
  await Promise.all([
    waitHttp(`http://127.0.0.1:${pa}/api/health`),
    waitHttp(`http://127.0.0.1:${pb}/api/health`),
  ]);
  await Promise.all([0, 1, 2].map((i) => startWorker(i)));
  spawnNode('apps/shop-stub/dist/main.js', {
    SHOP_STUB_PORT: String(ps),
    SHOP_STUB_API_URL: `http://127.0.0.1:${pn}/api`,
    SHOP_STUB_API_A_URL: `http://127.0.0.1:${pa}/api`,
    SHOP_STUB_API_B_URL: `http://127.0.0.1:${pb}/api`,
  });
  await waitHttp(`http://127.0.0.1:${ps}/health`);

  const dir = mkdtempSync(join(tmpdir(), 'ff-nginx-'));
  const conf = join(dir, 'nginx.conf');
  const tpl = execFileSync('cat', [join(ROOT, 'infra/nginx/nginx.conf')], { encoding: 'utf8' })
    .replace('server api-a:3000', `server 127.0.0.1:${pa}`)
    .replace('server api-b:3000', `server 127.0.0.1:${pb}`)
    .replace('server web:3001;', 'server 127.0.0.1:1;')
    .replace('listen 80;', `listen 127.0.0.1:${pn};`);
  writeFileSync(conf, tpl);
  const name = `ff-adv-nginx-${process.pid}`;
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'host',
      '-v',
      `${conf}:/etc/nginx/nginx.conf:ro`,
      'nginx:1.27',
    ],
    { stdio: 'ignore' },
  );
  await waitHttp(`http://127.0.0.1:${pn}/api/health`);

  const db = createDb({ url: dbUrl, poolSize: 5 });
  const stopAll = async (): Promise<void> => {
    await db.$disconnect();
    execFileSync('docker', ['rm', '-f', name, redisContainer], { stdio: 'ignore' });
    await Promise.all(
      procs.map(
        (p) =>
          new Promise<void>((res) =>
            p.exitCode !== null || p.signalCode !== null
              ? res()
              : (p.once('exit', () => res()),
                p.kill('SIGTERM'),
                setTimeout(() => p.kill('SIGKILL'), 3000).unref()),
          ),
      ),
    );
  };
  return {
    nginx: `http://127.0.0.1:${pn}`,
    apiA: `http://127.0.0.1:${pa}`,
    apiB: `http://127.0.0.1:${pb}`,
    stub: `http://127.0.0.1:${ps}`,
    databaseUrl: dbUrl,
    redisUrl,
    redisContainer,
    controlToken,
    env: base,
    db,
    workers: () => workers,
    startWorker,
    kill9Worker,
    stopAll,
  };
};
