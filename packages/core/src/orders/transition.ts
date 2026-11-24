// The one way an order changes status: lock, check the transition table, update, write history,
// outbox event and realtime message, all in the caller's transaction.
import { type Tx } from '@ff/db/client';
import { type Actor, type OrderStatus } from '@ff/shared/domain';
import { fail, ok, type Result } from '@ff/shared/result';
import { canTransition } from '@ff/shared/rules/status';
import { type Effects } from '../effects';
import { recordOrderEvent } from '../outbox';
import { EVENTS, rooms } from '../realtime';

export type LockedOrder = {
  readonly id: string;
  readonly shopId: string;
  readonly warehouseId: string | null;
  readonly status: OrderStatus;
  readonly statusVersion: number;
  readonly externalNumber: string;
};

export const lockOrder = async (tx: Tx, orderId: string): Promise<LockedOrder | null> => {
  const [r] = await tx.$queryRaw<
    {
      id: string;
      shop_id: string;
      warehouse_id: string | null;
      status: OrderStatus;
      status_version: number;
      external_number: string;
    }[]
  >`SELECT id, shop_id, warehouse_id, status, status_version, external_number FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  return r === undefined
    ? null
    : {
        id: r.id,
        shopId: r.shop_id,
        warehouseId: r.warehouse_id,
        status: r.status,
        statusVersion: r.status_version,
        externalNumber: r.external_number,
      };
};

export type TransitionInput = {
  readonly to: OrderStatus;
  readonly actor: Actor;
  readonly actorId: string | null;
  readonly reason?: string;
  readonly now: Date;
};

/** The order must already be locked by the caller (lockOrder). */
export const transition = async (
  tx: Tx,
  fx: Effects,
  order: LockedOrder,
  t: TransitionInput,
): Promise<Result<LockedOrder>> => {
  const allowed = canTransition(order.status, t.to, t.actor);
  if (!allowed.ok) return allowed;
  const version = order.statusVersion + 1;
  const n = await tx.$executeRaw`
    UPDATE orders SET status = ${t.to}::order_status, status_version = ${version}, updated_at = ${t.now}
    WHERE id = ${order.id}::uuid AND status = ${order.status}::order_status AND status_version = ${order.statusVersion}`;
  if (n !== 1) return fail('CONFLICT', 'order changed concurrently');
  await tx.$executeRaw`
    INSERT INTO order_status_history (order_id, version, from_status, to_status, actor_type, actor_id, reason, created_at)
    VALUES (${order.id}::uuid, ${version}, ${order.status}::order_status, ${t.to}::order_status, ${t.actor},
            ${t.actorId}::uuid, ${t.reason ?? null}, ${t.now})`;
  await recordOrderEvent(tx, fx, {
    shopId: order.shopId,
    orderId: order.id,
    externalNumber: order.externalNumber,
    status: t.to,
    previousStatus: order.status,
    version,
    at: t.now,
  });
  if (order.warehouseId !== null) {
    fx.realtime.push({
      room: rooms.lead(order.warehouseId),
      event: EVENTS.orderStatus,
      payload: { orderId: order.id, status: t.to, previousStatus: order.status, version },
    });
  }
  return ok({ ...order, status: t.to, statusVersion: version });
};

export const notFound = <T>(what: string): Result<T> => fail('NOT_FOUND', `${what} not found`);
