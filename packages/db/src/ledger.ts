// The movement ledger: every stock change is an append-only row; a trigger applies it to
// stock_balances in the same transaction (migration 0002).
import { Prisma, type Db, type Tx } from './client';
import { type MovementKind } from '@ff/shared/domain';

export type MovementRow = {
  readonly groupId: string;
  readonly kind: MovementKind;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly skuId: string;
  readonly batchId: string;
  readonly onHandDelta: number;
  readonly reservedDelta: number;
  readonly qty: number;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly docType: string;
  readonly docId: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly reason?: string | null;
  readonly at: Date;
};

const uuidOrNull = (v: string | null): Prisma.Sql => (v === null ? Prisma.sql`NULL` : Prisma.sql`${v}::uuid`);

/** Inserts movement rows; balances follow via trigger. Throws on CHECK violations (negative stock). */
export const insertMovements = async (tx: Tx, rows: readonly MovementRow[]): Promise<void> => {
  if (rows.length === 0) return;
  const values = rows.map(
    (r) => Prisma.sql`(${r.groupId}::uuid, ${r.kind}::movement_kind, ${r.warehouseId}::uuid, ${r.locationId}::uuid,
      ${r.skuId}::uuid, ${r.batchId}::uuid, ${r.onHandDelta}, ${r.reservedDelta}, ${r.qty},
      ${uuidOrNull(r.fromLocationId)}, ${uuidOrNull(r.toLocationId)}, ${r.docType}, ${r.docId}, ${r.actorType},
      ${uuidOrNull(r.actorId)}, ${r.reason ?? null}, ${r.at})`,
  );
  await tx.$executeRaw`
    INSERT INTO stock_movements (group_id, kind, warehouse_id, location_id, sku_id, batch_id, on_hand_delta,
      reserved_delta, qty, from_location_id, to_location_id, doc_type, doc_id, actor_type, actor_id, reason, created_at)
    VALUES ${Prisma.join(values)}`;
};

export type LedgerReport = {
  readonly ledgerMismatches: number;
  readonly reservationMismatches: number;
  readonly lineMismatches: number;
  readonly negativeBalances: number;
  readonly sample: readonly unknown[];
};

/** Current stock equals the ledger sum; reservations agree with balances and order lines. */
export const ledgerReport = async (db: Db | Tx): Promise<LedgerReport> => {
  const [l] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger_mismatches`;
  const [r] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM reservation_mismatches`;
  const [o] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM order_line_reservation_mismatches`;
  const [neg] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_balances WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand`;
  const sample = await db.$queryRaw<unknown[]>`SELECT * FROM ledger_mismatches LIMIT 5`;
  return {
    ledgerMismatches: l?.n ?? 0,
    reservationMismatches: r?.n ?? 0,
    lineMismatches: o?.n ?? 0,
    negativeBalances: neg?.n ?? 0,
    sample,
  };
};

export const isBalanced = (r: LedgerReport): boolean =>
  r.ledgerMismatches === 0 && r.reservationMismatches === 0 && r.lineMismatches === 0 && r.negativeBalances === 0;
