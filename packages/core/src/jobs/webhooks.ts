// Webhook delivery (ASSIGNMENT "Webhooks"; invariant 9). One action per (shop, stream); the stream
// row lock makes delivery single-flight, so versions never reach the shop out of order.
// Order streams deliver every event in version order. Stock streams send at most one event per
// window, built from the CURRENT stock at send time, and never resend an older value after a newer.
import { type Db, type Tx } from '@ff/db/client';
import { withTx } from '@ff/db/tx';
import { decryptSecret } from '@ff/shared/crypto/secrets';
import { EVENT_ID_HEADER, nextStockSendAt, SIGNATURE_HEADER, signWebhook } from '@ff/shared/rules/webhook';
import { type Clock } from '../clock';
import { type Effects } from '../effects';
import { type ActionRow } from '../scheduled-actions';
import { postWebhook, type HttpOutcome } from './webhook-http';

export type WebhookSettings = {
  readonly encKey: string;
  readonly timeoutMs: number;
  readonly coalesceMs: number;
  readonly allowPrivate: boolean;
};
export type WebhookDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly webhooks: WebhookSettings;
  readonly send?: typeof postWebhook;
};

type StreamRow = {
  shop_id: string;
  stream: string;
  last_version: number;
  last_sent_at: Date | null;
  dirty: boolean;
};
type ShopRow = { webhook_url: string; webhook_secret_enc: string };
type EventRow = {
  id: string;
  version: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
};

const describe = (o: HttpOutcome): string => ('status' in o ? `http ${o.status}` : o.error);

// The signature timestamp is real wall time: receivers check it against their own clock, while
// business time (the shared test clock) only moves what the events say.
const deliver = async (
  d: WebhookDeps,
  shop: ShopRow,
  ev: {
    id: string;
    version: number;
    type: string;
    stream: string;
    occurredAt: string;
    data: Record<string, unknown>;
  },
) => {
  const secret = decryptSecret(d.webhooks.encKey, shop.webhook_secret_enc);
  const body = JSON.stringify({
    eventId: ev.id,
    type: ev.type,
    stream: ev.stream,
    version: ev.version,
    occurredAt: ev.occurredAt,
    data: ev.data,
  });
  return (d.send ?? postWebhook)(
    shop.webhook_url,
    body,
    {
      [SIGNATURE_HEADER]: signWebhook(secret, body, Math.floor(Date.now() / 1000)),
      [EVENT_ID_HEADER]: ev.id,
    },
    { timeoutMs: d.webhooks.timeoutMs, allowPrivate: d.webhooks.allowPrivate },
  );
};

const lockStream = async (tx: Tx, shopId: string, stream: string): Promise<StreamRow | null> =>
  (
    await tx.$queryRaw<StreamRow[]>`
      SELECT shop_id, stream, last_version, last_sent_at, dirty FROM webhook_streams
      WHERE shop_id = ${shopId}::uuid AND stream = ${stream} FOR UPDATE`
  )[0] ?? null;

/** Records a failed delivery and returns how many attempts this event has had. */
const markFailed = async (tx: Tx, id: string, err: string, nextAt: Date): Promise<number> => {
  const [row] = await tx.$queryRaw<{ attempts: number }[]>`
    UPDATE webhook_events SET attempts = attempts + 1, last_error = ${err}, next_attempt_at = ${nextAt}, status = 'pending'
    WHERE id = ${id}::uuid RETURNING attempts`;
  return row?.attempts ?? 1;
};

/** Order streams: deliver pending events in version order; stop (and retry later) on the first failure. */
const deliverOrderStream = async (
  d: WebhookDeps,
  tx: Tx,
  shop: ShopRow,
  shopId: string,
  stream: string,
  now: Date,
): Promise<void> => {
  const events = await tx.$queryRaw<EventRow[]>`
    SELECT id, version, type, payload, created_at FROM webhook_events
    WHERE shop_id = ${shopId}::uuid AND stream = ${stream} AND status IN ('pending', 'delivering') ORDER BY version`;
  for (const e of events) {
    const { type: _t, ...data } = e.payload;
    const r = await deliver(d, shop, {
      id: e.id,
      version: e.version,
      type: e.type,
      stream,
      occurredAt: e.created_at.toISOString(),
      data,
    });
    if ('status' in r && r.status >= 200 && r.status < 300) {
      await tx.$executeRaw`UPDATE webhook_events SET status = 'delivered', delivered_at = ${d.clock.now()}, attempts = attempts + 1 WHERE id = ${e.id}::uuid`;
      continue;
    }
    const eventAttempts = await markFailed(tx, e.id, describe(r), now);
    // The retry budget is this event's own attempt count (see processAction), not the stream run's.
    throw Object.assign(new Error(`webhook ${stream} v${e.version} failed: ${describe(r)}`), {
      eventAttempts,
    });
  }
};

const currentStock = async (tx: Tx, skuId: string, now: Date) => {
  const rows = await tx.$queryRaw<
    { warehouse_id: string; code: string; on_shelf: number; reserved: number; available: number }[]
  >`
    SELECT w.id AS warehouse_id, w.code,
      COALESCE(SUM(b.on_hand) FILTER (WHERE l.kind = 'storage'), 0)::int AS on_shelf,
      COALESCE(SUM(b.reserved) FILTER (WHERE l.kind = 'storage'), 0)::int AS reserved,
      COALESCE(SUM(b.on_hand - b.reserved) FILTER (WHERE l.kind = 'storage' AND l.blocked_reason IS NULL
        AND (bt.expires_on IS NULL OR bt.expires_on - ${now.toISOString().slice(0, 10)}::date >= sh.min_shelf_life_days)), 0)::int AS available
    FROM warehouses w CROSS JOIN skus s JOIN shops sh ON sh.id = s.shop_id
    LEFT JOIN stock_balances b ON b.sku_id = s.id AND b.warehouse_id = w.id
    LEFT JOIN locations l ON l.id = b.location_id LEFT JOIN batches bt ON bt.id = b.batch_id
    WHERE s.id = ${skuId}::uuid GROUP BY w.id, w.code ORDER BY w.code`;
  const sku = await tx.$queryRaw<{ code: string }[]>`SELECT code FROM skus WHERE id = ${skuId}::uuid`;
  return {
    skuId,
    sku: sku[0]?.code ?? '',
    available: rows.reduce((s, r) => s + r.available, 0),
    warehouses: rows.map((r) => ({
      warehouseId: r.warehouse_id,
      warehouseCode: r.code,
      onShelf: r.on_shelf,
      reserved: r.reserved,
      available: r.available,
    })),
  };
};

/** Stock streams: coalesce to one send per window with the latest value; supersede older events. */
const deliverStockStream = async (
  d: WebhookDeps,
  tx: Tx,
  shop: ShopRow,
  s: StreamRow,
  now: Date,
): Promise<{ next: Date | null }> => {
  if (!s.dirty) return { next: null };
  const due = nextStockSendAt(now, s.last_sent_at, d.webhooks.coalesceMs);
  if (due.getTime() > now.getTime()) return { next: due };
  const skuId = s.stream.slice('stock:'.length);
  await tx.$executeRaw`UPDATE webhook_events SET status = 'superseded' WHERE shop_id = ${s.shop_id}::uuid AND stream = ${s.stream} AND status IN ('pending', 'delivering')`;
  const version = s.last_version + 1;
  const data = await currentStock(tx, skuId, now);
  const [ev] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO webhook_events (shop_id, stream, version, type, payload, status, next_attempt_at, created_at)
    VALUES (${s.shop_id}::uuid, ${s.stream}, ${version}, 'stock.available_changed', ${JSON.stringify(data)}::jsonb, 'delivering', ${now}, ${now}) RETURNING id`;
  if (ev === undefined) throw new Error('webhook event insert failed');
  // The version is consumed even if delivery fails, so a later event can never reuse it.
  await tx.$executeRaw`UPDATE webhook_streams SET last_version = ${version} WHERE shop_id = ${s.shop_id}::uuid AND stream = ${s.stream}`;
  // The 5 s window runs from the moment the send STARTS, so latency can never shorten the gap.
  const startedAt = d.clock.now();
  const r = await deliver(d, shop, {
    id: ev.id,
    version,
    type: 'stock.available_changed',
    stream: s.stream,
    occurredAt: now.toISOString(),
    data,
  });
  if ('status' in r && r.status >= 200 && r.status < 300) {
    await tx.$executeRaw`UPDATE webhook_events SET status = 'delivered', delivered_at = ${d.clock.now()}, attempts = 1 WHERE id = ${ev.id}::uuid`;
    await tx.$executeRaw`UPDATE webhook_streams SET last_sent_at = ${startedAt}, dirty = false WHERE shop_id = ${s.shop_id}::uuid AND stream = ${s.stream}`;
    return { next: null };
  }
  await markFailed(tx, ev.id, describe(r), now);
  throw new Error(`webhook ${s.stream} v${version} failed: ${describe(r)}`);
};

/** Handler for a `webhook_stream` action (key = "<shopId>|<stream>"). */
export const handleWebhookStream = async (
  d: WebhookDeps,
  row: ActionRow,
  _fx: Effects,
): Promise<{ readonly next: Date | null }> => {
  const [shopId = '', ...rest] = row.key.split('|');
  const stream = rest.join('|');
  const failure: { error: Error | null } = { error: null };
  const result = await withTx(
    d.db,
    async (tx) => {
      const now = d.clock.now();
      const s = await lockStream(tx, shopId, stream);
      const [shop] = await tx.$queryRaw<
        ShopRow[]
      >`SELECT webhook_url, webhook_secret_enc FROM shops WHERE id = ${shopId}::uuid`;
      if (s === null || shop === undefined) return { next: null };
      try {
        if (stream.startsWith('order:')) {
          await deliverOrderStream(d, tx, shop, shopId, stream, now);
          return { next: null };
        }
        return await deliverStockStream(d, tx, shop, s, now);
      } catch (e) {
        // Keep the failure bookkeeping (attempt counts, errors) and report it after commit.
        failure.error = e instanceof Error ? e : new Error(String(e));
        return { next: null };
      }
    },
    { timeoutMs: d.webhooks.timeoutMs * 4 + 10_000 },
  );
  if (failure.error !== null) throw failure.error;
  return result;
};

/** After a manual rerun of a dead stream, its dead events are pending again. */
export const reviveDeadEvents = async (db: Db, shopId: string, stream: string, now: Date): Promise<void> => {
  await db.$executeRaw`UPDATE webhook_events SET status = 'pending', attempts = 0, next_attempt_at = ${now} WHERE shop_id = ${shopId}::uuid AND stream = ${stream} AND status = 'dead'`;
};
