// Socket.IO across api copies: the Redis adapter fans events out; the worker publishes through the
// same channel with the Redis emitter. If Redis is lost, clients reconnect and refetch from REST.
import { type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { type Redis } from 'ioredis';
import { type Server, type ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      transports: ['websocket'],
      maxHttpBufferSize: 64_000,
    }) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }
}
