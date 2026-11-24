// Redis connections. Redis holds only disposable state; losing it loses nothing (plan.md A-28).
import { Redis, type RedisOptions } from 'ioredis';
import { Emitter as SocketEmitter } from '@socket.io/redis-emitter';
import { type Emitter } from './realtime';

export const redisOptions = (url: string): RedisOptions => ({
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 100, 2000),
  ...parseRedisUrl(url),
});

const parseRedisUrl = (url: string): RedisOptions => {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: Number(u.pathname.replace('/', '') || 0),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
  };
};

export const createRedis = (url: string, name: string): Redis =>
  new Redis({ ...redisOptions(url), connectionName: name });

/** Emits to Socket.IO rooms from any process via the Redis adapter's pub/sub channel. */
export const createRedisEmitter = (redis: Redis): Emitter => {
  const io = new SocketEmitter(redis);
  return {
    emit: (messages) => {
      for (const m of messages) io.to(m.room).emit(m.event, m.payload);
    },
  };
};
