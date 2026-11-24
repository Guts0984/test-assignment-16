// Order search by number, customer and SKU (budget: < 300 ms on the full seed).
import { Prisma, type Db } from '@ff/db/client';
import { type OrderStatus } from '@ff/shared/domain';
import { fail, ok, type Result } from '@ff/shared/result';
import { decodeCursor, encodeCursor, escapeLike, type Page } from '../stock/view';

export type OrderSearchQuery = {
  readonly q?: string;
  readonly status?: OrderStatus;
  /** null = every warehouse (admin); otherwise the caller's warehouses. */
  readonly warehouseIds: readonly string[] | null;
  /** Set for shop principals: they only ever see their own orders. */
  readonly shopId?: string;
  readonly limit: number;
  readonly cursor?: string;
};

export type OrderListItem = {
  readonly id: string;
  readonly shopId: string;
  readonly externalNumber: string;
  readonly status: OrderStatus;
  readonly deliveryMethod: string;
  readonly customerName: string;
  readonly warehouseId: string | null;
  readonly receivedAt: Date;
  readonly targetCutoffAt: Date | null;
  readonly shipDay: Date | null;
};

type Raw = {
  id: string;
  shop_id: string;
  external_number: string;
  status: OrderStatus;
  delivery_method: string;
  customer_name: string;
  warehouse_id: string | null;
  received_at: Date;
  target_cutoff_at: Date | null;
  ship_day: Date | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const searchOrders = async (db: Db, s: OrderSearchQuery): Promise<Result<Page<OrderListItem>>> => {
  const q = s.q?.trim().toLowerCase() ?? '';
  const shop = s.shopId === undefined ? Prisma.empty : Prisma.sql`AND o.shop_id = ${s.shopId}::uuid`;
  const matches =
    q === ''
      ? null
      : Prisma.sql`
        SELECT id FROM orders WHERE lower(external_number) LIKE ${`${escapeLike(q)}%`}
        ${q.length >= 3 ? Prisma.sql`UNION SELECT id FROM orders WHERE lower(customer_name) LIKE ${`%${escapeLike(q)}%`}` : Prisma.empty}
        UNION SELECT l.order_id FROM order_lines l
          WHERE l.sku_id IN (SELECT id FROM skus WHERE lower(code) = ${q} OR lower(barcode) = ${q}
                             ${s.shopId === undefined ? Prisma.empty : Prisma.sql`AND shop_id = ${s.shopId}::uuid`})`;
  const cur = decodeCursor(s.cursor, 2);
  if (s.cursor !== undefined && (cur === null || Number.isNaN(Date.parse(cur[0] ?? '')) || !UUID_RE.test(cur[1] ?? ''))) {
    return fail('VALIDATION_FAILED', 'invalid cursor');
  }
  const rows = await db.$queryRaw<Raw[]>`
    ${matches === null ? Prisma.empty : Prisma.sql`WITH m AS (${matches})`}
    SELECT o.id, o.shop_id, o.external_number, o.status, o.delivery_method, o.customer_name, o.warehouse_id,
           o.received_at, o.target_cutoff_at, o.ship_day
    FROM orders o ${matches === null ? Prisma.empty : Prisma.sql`JOIN m ON m.id = o.id`}
    WHERE true ${shop}
      ${s.status === undefined ? Prisma.empty : Prisma.sql`AND o.status = ${s.status}::order_status`}
      ${s.warehouseIds === null ? Prisma.empty : Prisma.sql`AND o.warehouse_id = ANY(${[...s.warehouseIds]}::uuid[])`}
      ${cur === null ? Prisma.empty : Prisma.sql`AND (o.received_at, o.id) < (${new Date(cur[0] ?? '')}, ${cur[1] ?? ''}::uuid)`}
    ORDER BY o.received_at DESC, o.id DESC
    LIMIT ${s.limit + 1}`;
  const items = rows.slice(0, s.limit).map(
    (r): OrderListItem => ({
      id: r.id,
      shopId: r.shop_id,
      externalNumber: r.external_number,
      status: r.status,
      deliveryMethod: r.delivery_method,
      customerName: r.customer_name,
      warehouseId: r.warehouse_id,
      receivedAt: r.received_at,
      targetCutoffAt: r.target_cutoff_at,
      shipDay: r.ship_day,
    }),
  );
  const last = items[items.length - 1];
  return ok({
    items,
    nextCursor: rows.length > s.limit && last !== undefined ? encodeCursor([last.receivedAt.toISOString(), last.id]) : null,
  });
};
