// Realtime: authenticated on connect, rooms joined only on the server from the caller's rights
// (invariant 12 for sockets). Shops only ever join their own shop room.
import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { type Redis } from 'ioredis';
import { type Socket } from 'socket.io';
import { z } from 'zod';
import { rooms } from '@ff/core/realtime';
import { type ApiEnv } from '../../config/env';
import { ENV, REDIS } from '../../infra/tokens';
import { hasRoleAt, warehousesOf, type Principal } from '../../common/auth/principal';
import { AuthService } from '../auth/auth.service';
import { clearPresence, touchPresence } from './presence';

type Data = { principal?: Principal; budget?: { second: number; used: number; strikes: number } };
const subscribeSchema = z.object({ warehouseId: z.string().uuid() }).strict();

/** Rooms a principal is entitled to, derived on the server only. */
export const roomsFor = (p: Principal): readonly string[] => {
  if (p.kind !== 'staff') return [rooms.shop(p.shopId)];
  const lead = warehousesOf(p, ['shift_lead']);
  const floor = warehousesOf(p, ['picker', 'storekeeper', 'packer', 'shift_lead']);
  return [
    ...(lead === 'all' ? [] : lead.map(rooms.lead)),
    ...(floor === 'all' ? [] : floor.map(rooms.floor)),
    ...(p.roles.some((r) => r.role === 'picker') ? [rooms.picker(p.id)] : []),
  ];
};

const pickerWarehouses = (p: Principal): readonly string[] => {
  const w = warehousesOf(p, ['picker']);
  return w === 'all' ? [] : w;
};

@WebSocketGateway({ path: '/socket.io', transports: ['websocket'] })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('realtime');

  constructor(
    private readonly auth: AuthService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    const token: unknown = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
    const r = await this.auth.resolveBearer(typeof token === 'string' ? `Bearer ${token}` : undefined);
    if (!r.ok) {
      socket.emit('auth_error', { code: r.error.code });
      socket.disconnect(true);
      return;
    }
    const data = socket.data as Data;
    data.principal = r.value;
    await socket.join([...roomsFor(r.value)]);
    if (r.value.kind === 'staff')
      await touchPresence(
        this.redis,
        pickerWarehouses(r.value),
        r.value.id,
        this.env.SOCKET_PRESENCE_TTL_SEC,
      ).catch(() => undefined);
    socket.emit('ready', { rooms: [...socket.rooms].filter((x) => x !== socket.id) });
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const p = (socket.data as Data).principal;
    if (p?.kind === 'staff')
      await clearPresence(this.redis, pickerWarehouses(p), p.id).catch(() => undefined);
  }

  /** Per-socket message budget; floods are dropped and repeat offenders disconnected. */
  private allow(socket: Socket): boolean {
    const data = socket.data as Data;
    const second = Math.floor(Date.now() / 1000);
    const b = data.budget ?? { second, used: 0, strikes: 0 };
    const next = b.second === second ? { ...b, used: b.used + 1 } : { second, used: 1, strikes: b.strikes };
    const over = next.used > this.env.RATE_LIMIT_SOCKET_MSG_PER_SEC;
    data.budget =
      over && next.used === this.env.RATE_LIMIT_SOCKET_MSG_PER_SEC + 1
        ? { ...next, strikes: next.strikes + 1 }
        : next;
    if ((data.budget.strikes ?? 0) >= 3) {
      this.logger.warn('socket disconnected for flooding');
      socket.disconnect(true);
    }
    return !over;
  }

  /** A shift lead (or admin) asks for a warehouse dashboard room; rights are checked here. */
  @SubscribeMessage('subscribe')
  subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: boolean; error?: string } {
    if (!this.allow(socket)) return { ok: false, error: 'RATE_LIMITED' };
    const p = (socket.data as Data).principal;
    const parsed = subscribeSchema.safeParse(body);
    if (p === undefined || !parsed.success) return { ok: false, error: 'VALIDATION_FAILED' };
    if (!hasRoleAt(p, parsed.data.warehouseId, ['shift_lead'])) return { ok: false, error: 'FORBIDDEN' };
    void socket.join(rooms.lead(parsed.data.warehouseId));
    return { ok: true };
  }

  /** Heartbeat: refreshes presence and re-checks the token, so revoked access ends the socket too. */
  @SubscribeMessage('presence')
  async presence(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<{ ok: boolean }> {
    if (!this.allow(socket)) return { ok: false };
    const token = (body as { token?: unknown } | null)?.token;
    const r = await this.auth.resolveBearer(typeof token === 'string' ? `Bearer ${token}` : undefined);
    if (!r.ok) {
      socket.disconnect(true);
      return { ok: false };
    }
    (socket.data as Data).principal = r.value;
    if (r.value.kind === 'staff')
      await touchPresence(
        this.redis,
        pickerWarehouses(r.value),
        r.value.id,
        this.env.SOCKET_PRESENCE_TTL_SEC,
      ).catch(() => undefined);
    return { ok: true };
  }
}
