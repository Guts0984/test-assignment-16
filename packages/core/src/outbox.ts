// Webhook outbox: events are rows written in the same transaction as the change that caused
// them, so a retry never loses or duplicates an event (plan.md A-26).
import { type Tx } from '@ff/db/client';
import { nextStockSendAt } from '@ff/shared/rules/webhook';
import { type Effects } from './effects';
import { EVENTS, rooms } from './realtime';
import { scheduleAction } from './scheduled-actions';

export const orderStream = (orderId: string): string => `order:${orderId}`;
export const stockStream = (skuId: string): string => `stock:${skuId}`;
export const streamActionKey = (shopId: string, stream: string): string => `${shopId}|${stream}`;

export type OrderEvent = {
  readonly shopId: string;
  readonly orderId: string;
  readonly externalNumber: string;
  readonly status: string;
  readonly previousStatus: string | null;
  readonly version: number;
  readonly at: Date;
};

/** Order status events: one stream per order, version = order status_version, delivered in order. */
export const recordOrderEvent = async (tx: Tx, fx: Effects, e: OrderEvent): Promise<void> => {
  const stream = orderStream(e.orderId);
  const payload = {
    type: 'order.status_changed',
    orderId: e.orderId,
    externalNumber: e.externalNumber,
    status: e.status,
    previousStatus: e.previousStatus,
    version: e.version,
    occurredAt: e.at.toISOString(),
  };
  await tx.$executeRaw`
    INSERT INTO webhook_events (shop_id, stream, version, type, payload, status, next_attempt_at, created_at)
    VALUES (${e.shopId}::uuid, ${stream}, ${e.version}, 'order.status_changed', ${JSON.stringify(payload)}::jsonb, 'pending', ${e.at}, ${e.at})
    ON CONFLICT (shop_id, stream, version) DO NOTHING`;
  await tx.$executeRaw`
    INSERT INTO webhook_streams (shop_id, stream, last_version) VALUES (${e.shopId}::uuid, ${stream}, ${e.version})
    ON CONFLICT (shop_id, stream) DO UPDATE SET last_version = GREATEST(webhook_streams.last_version, EXCLUDED.last_version)`;
  const key = streamActionKey(e.shopId, stream);
  await scheduleAction(tx, { kind: 'webhook_stream', key, dueAt: e.at });
  fx.actions.push({ kind: 'webhook_stream', key });
  fx.realtime.push({
    room: rooms.shop(e.shopId),
    event: EVENTS.orderStatus,
    payload: { orderId: e.orderId, status: e.status, version: e.version },
  });
};

/**
 * Available stock changed for these SKUs: mark each (shop, sku) stream dirty and schedule one send
 * no earlier than 5 s after the previous one. The payload is built at send time from current
 * stock, so the shop always gets the latest value (coalescing).
 */
export const markStockChanged = async (
  tx: Tx,
  fx: Effects,
  skuIds: readonly string[],
  now: Date,
  windowMs: number,
): Promise<void> => {
  const unique = [...new Set(skuIds)];
  if (unique.length === 0) return;
  const rows = await tx.$queryRaw<{ shop_id: string; sku_id: string; last_sent_at: Date | null }[]>`
    INSERT INTO webhook_streams (shop_id, stream, dirty)
    SELECT s.shop_id, 'stock:' || s.id, true FROM skus s WHERE s.id = ANY(${unique}::uuid[])
    ON CONFLICT (shop_id, stream) DO UPDATE SET dirty = true
    RETURNING shop_id, substring(stream from 7) AS sku_id, last_sent_at`;
  for (const r of rows) {
    const key = streamActionKey(r.shop_id, stockStream(r.sku_id));
    await scheduleAction(tx, { kind: 'webhook_stream', key, dueAt: nextStockSendAt(now, r.last_sent_at, windowMs) });
    fx.actions.push({ kind: 'webhook_stream', key });
    fx.realtime.push({ room: rooms.shop(r.shop_id), event: EVENTS.stockChanged, payload: { skuId: r.sku_id } });
  }
};
