// Stock per SKU per warehouse (ASSIGNMENT shop scenario 3): on shelf, reserved, available,
// in transit; plus goods received but not yet placed on a shelf.
import { Prisma, type Db } from '@ff/db/client';

export type StockRow = {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly onShelf: number;
  readonly reserved: number;
  readonly available: number;
  readonly inTransit: number;
  readonly receiving: number;
};

type Raw = {
  sku_id: string;
  sku_code: string;
  sku_name: string;
  warehouse_id: string;
  warehouse_code: string;
  on_shelf: number;
  reserved: number;
  available: number;
  in_transit: number;
  receiving: number;
};

/**
 * Available = on hand minus reserved, in storage cells that are not blocked (count, shortage),
 * for batches with enough remaining shelf life for the shop. Stock in transit belongs to the
 * destination warehouse but is never available until received.
 */
export const stockForSkus = async (
  db: Db,
  skuIds: readonly string[],
  asOfDate: string,
  warehouseId: string | null,
): Promise<readonly StockRow[]> => {
  if (skuIds.length === 0) return [];
  const whFilter = warehouseId === null ? Prisma.empty : Prisma.sql`AND w.id = ${warehouseId}::uuid`;
  const rows = await db.$queryRaw<Raw[]>`
    SELECT s.id AS sku_id, s.code AS sku_code, s.name AS sku_name, w.id AS warehouse_id, w.code AS warehouse_code,
      COALESCE(SUM(b.on_hand) FILTER (WHERE l.kind = 'storage'), 0)::int AS on_shelf,
      COALESCE(SUM(b.reserved) FILTER (WHERE l.kind = 'storage'), 0)::int AS reserved,
      COALESCE(SUM(b.on_hand - b.reserved) FILTER (
        WHERE l.kind = 'storage' AND l.blocked_reason IS NULL
          AND (bt.expires_on IS NULL OR bt.expires_on - ${asOfDate}::date >= sh.min_shelf_life_days)), 0)::int AS available,
      COALESCE(SUM(b.on_hand) FILTER (WHERE l.kind = 'transit'), 0)::int AS in_transit,
      COALESCE(SUM(b.on_hand) FILTER (WHERE l.kind IN ('receiving', 'return')), 0)::int AS receiving
    FROM skus s
    JOIN shops sh ON sh.id = s.shop_id
    CROSS JOIN warehouses w
    LEFT JOIN stock_balances b ON b.sku_id = s.id AND b.warehouse_id = w.id
    LEFT JOIN locations l ON l.id = b.location_id
    LEFT JOIN batches bt ON bt.id = b.batch_id
    WHERE s.id = ANY(${[...skuIds]}::uuid[]) ${whFilter}
    GROUP BY s.id, s.code, s.name, w.id, w.code
    ORDER BY s.code, w.code`;
  return rows.map((r) => ({
    skuId: r.sku_id,
    skuCode: r.sku_code,
    skuName: r.sku_name,
    warehouseId: r.warehouse_id,
    warehouseCode: r.warehouse_code,
    onShelf: r.on_shelf,
    reserved: r.reserved,
    available: r.available,
    inTransit: r.in_transit,
    receiving: r.receiving,
  }));
};

/** Escapes LIKE wildcards so user input is matched literally. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null };

export const encodeCursor = (parts: readonly string[]): string =>
  Buffer.from(parts.join('\u0001')).toString('base64url');
export const decodeCursor = (c: string | undefined, n: number): readonly string[] | null => {
  if (c === undefined) return null;
  const parts = Buffer.from(c, 'base64url').toString('utf8').split('\u0001');
  return parts.length === n ? parts : null;
};

/** One page of a shop's SKUs (by code), optionally filtered by code / barcode / name prefix. */
export const shopSkuPage = async (
  db: Db,
  shopId: string,
  q: string | undefined,
  limit: number,
  cursor: string | undefined,
): Promise<Page<{ id: string; code: string }>> => {
  const after = decodeCursor(cursor, 1)?.[0];
  const term = q === undefined || q.trim() === '' ? null : `${escapeLike(q.trim().toLowerCase())}%`;
  const rows = await db.$queryRaw<{ id: string; code: string }[]>`
    SELECT id, code FROM skus WHERE shop_id = ${shopId}::uuid
      ${term === null ? Prisma.empty : Prisma.sql`AND (lower(code) LIKE ${term} OR lower(barcode) LIKE ${term} OR lower(name) LIKE ${term})`}
      ${after === undefined ? Prisma.empty : Prisma.sql`AND code > ${after}`}
    ORDER BY code LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor([last.code]) : null };
};
