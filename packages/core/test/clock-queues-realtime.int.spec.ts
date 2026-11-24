// Shared test clock across processes, BullMQ dedup by job id and Redis loss, and Socket.IO fan-out
// across two servers (the two api copies) plus the worker's emitter.
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ff/db/client';
import { changeTestClock, startSharedTestClock } from '../src/clock';
import { createQueues } from '../src/queues';
import { createRedis, createRedisEmitter, redisOptions } from '../src/redis';
import { testEnv } from './setup/test-env';

let db: Db;
beforeAll(() => {
  db = createDb({ url: testEnv.DATABASE_URL, poolSize: 5 });
});
afterAll(async () => db.$disconnect());

const until = async (cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('shared test clock', () => {
  it('two processes see the same advanced time within milliseconds', async () => {
    const a = await startSharedTestClock(testEnv.DATABASE_URL);
    const b = await startSharedTestClock(testEnv.DATABASE_URL);
    try {
      await changeTestClock(db, { reset: true });
      await changeTestClock(db, { advanceMs: 15 * 60_000 });
      await until(() => a.offsetMs() === 15 * 60_000 && b.offsetMs() === 15 * 60_000);
      expect(Math.abs(a.clock.now().getTime() - Date.now() - 15 * 60_000)).toBeLessThan(1000);
      const target = new Date('2026-03-27T16:01:00Z');
      await changeTestClock(db, { setTo: target });
      await until(() => Math.abs(b.clock.now().getTime() - target.getTime()) < 1000);
    } finally {
      await changeTestClock(db, { reset: true });
      await a.stop();
      await b.stop();
    }
  });
});

describe('BullMQ queues', () => {
  it('the same job id is enqueued once; after FLUSHALL it can be enqueued again', async () => {
    const queues = createQueues(redisOptions(testEnv.REDIS_URL), `t${Date.now()}`);
    const redis = createRedis(testEnv.REDIS_URL, 'test');
    try {
      await Promise.all(Array.from({ length: 10 }, () => queues.enqueue('wave_timer', 'a1', 'job-1')));
      expect(await queues.raw.waves.getJobCounts('waiting', 'delayed', 'active')).toMatchObject({ waiting: 1 });
      await redis.flushdb();
      expect((await queues.raw.waves.getJobCounts('waiting')).waiting).toBe(0);
      await queues.enqueue('wave_timer', 'a1', 'job-1');
      expect((await queues.raw.waves.getJobCounts('waiting')).waiting).toBe(1);
    } finally {
      await redis.flushdb();
      await queues.close();
      redis.disconnect();
    }
  });
});

describe('Socket.IO across two servers', () => {
  it('an event emitted on server B or by the worker emitter reaches a client of server A in < 1 s', async () => {
    const mk = async () => {
      const pub = createRedis(testEnv.REDIS_URL, 'pub');
      const sub = pub.duplicate();
      const http = createServer();
      const io = new Server(http, { adapter: createAdapter(pub, sub) });
      io.on('connection', (s) => void s.join('wh:1:lead'));
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
      return { io, http, pub, sub, port: (http.address() as AddressInfo).port };
    };
    const a = await mk();
    const b = await mk();
    const emitterRedis = createRedis(testEnv.REDIS_URL, 'emitter');
    const client: Socket = connect(`http://127.0.0.1:${a.port}`, { transports: ['websocket'] });
    try {
      await until(() => client.connected);
      await until(async () => (await b.io.fetchSockets()).length === 1);
      const got: number[] = [];
      client.on('pick.scan', (p: { sentAt: number }) => got.push(Date.now() - p.sentAt));
      b.io.to('wh:1:lead').emit('pick.scan', { sentAt: Date.now() });
      createRedisEmitter(emitterRedis).emit([{ room: 'wh:1:lead', event: 'pick.scan', payload: { sentAt: Date.now() } }]);
      await until(() => got.length === 2);
      expect(Math.max(...got)).toBeLessThan(1000);
    } finally {
      client.close();
      for (const s of [a, b]) {
        s.io.close();
        s.pub.disconnect();
        s.sub.disconnect();
      }
      emitterRedis.disconnect();
    }
  });
});
