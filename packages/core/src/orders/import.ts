// Idempotent order import (ASSIGNMENT "Order import", invariant 8): the same shop order number
// creates one order; a repeat with the same content returns it; different content is an error.
import { createHash } from 'node:crypto';
import { type Db } from '@ff/db/client';
import { withTx } from '@ff/db/tx';
import { fail, ok, type Result } from '@ff/shared/result';
import { type CreateOrderInput } from '@ff/shared/schemas/orders';
import { type Clock } from '../clock';
import { type Effects } from '../effects';
import { recordOrderEvent } from '../outbox';
import { scheduleAction } from '../scheduled-actions';

/** JSON with sorted keys, so the same order always hashes the same. */
export const stableStringify = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

export const payloadHash = (input: CreateOrderInput): string =>
  createHash('sha256').update(stableStringify(input)).digest('hex');

export type ImportOutcome = { readonly orderId: string; readonly created: boolean; readonly status: string };

export const importOrder = async (
  d: { readonly db: Db; readonly clock: Clock },
  fx: Effects,
  shopId: string,
  input: CreateOrderInput,
): Promise<Result<ImportOutcome>> => {
  const hash = payloadHash(input);
  const codes = input.lines.map((l) => l.sku);
  return withTx(d.db, async (tx) => {
    const now = d.clock.now();
    const skus = await tx.$queryRaw<{ id: string; code: string }[]>`
      SELECT id, code FROM skus WHERE shop_id = ${shopId}::uuid AND code = ANY(${codes}::text[])`;
    const byCode = new Map(skus.map((s) => [s.code, s.id]));
    const missing = codes.filter((c) => !byCode.has(c));
    if (missing.length > 0) return fail('UNKNOWN_SKU', 'unknown SKU codes for this shop', { skus: missing });

    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO orders (shop_id, external_number, payload_hash, status, delivery_method, address, customer_name, country,
                          lat, lon, received_at, status_version, updated_at)
      VALUES (${shopId}::uuid, ${input.externalNumber}, ${hash}, 'received', ${input.deliveryMethod}::delivery_method,
              ${JSON.stringify(input.address)}::jsonb, ${input.address.name}, ${input.address.country},
              ${input.address.lat ?? null}, ${input.address.lon ?? null}, ${now}, 1, ${now})
      ON CONFLICT (shop_id, external_number) DO NOTHING
      RETURNING id`;
    const created = inserted[0];
    if (created === undefined) {
      const [existing] = await tx.$queryRaw<{ id: string; payload_hash: string; status: string }[]>`
        SELECT id, payload_hash, status FROM orders WHERE shop_id = ${shopId}::uuid AND external_number = ${input.externalNumber}`;
      if (existing === undefined) return fail('CONFLICT', 'order import raced with a rollback; retry');
      return existing.payload_hash === hash
        ? ok({ orderId: existing.id, created: false, status: existing.status })
        : fail('ORDER_CONFLICT', 'an order with this number already exists with different content', {
            orderId: existing.id,
          });
    }
    for (const [i, l] of input.lines.entries()) {
      await tx.$executeRaw`
        INSERT INTO order_lines (order_id, line_no, sku_id, qty) VALUES (${created.id}::uuid, ${i + 1}, ${byCode.get(l.sku)}::uuid, ${l.qty})`;
    }
    await tx.$executeRaw`
      INSERT INTO order_status_history (order_id, version, from_status, to_status, actor_type, created_at)
      VALUES (${created.id}::uuid, 1, NULL, 'received', 'shop', ${now})`;
    await recordOrderEvent(tx, fx, {
      shopId,
      orderId: created.id,
      externalNumber: input.externalNumber,
      status: 'received',
      previousStatus: null,
      version: 1,
      at: now,
    });
    await scheduleAction(tx, { kind: 'reserve_order', key: created.id, dueAt: now });
    fx.actions.push({ kind: 'reserve_order', key: created.id });
    return ok({ orderId: created.id, created: true, status: 'received' });
  });
};
