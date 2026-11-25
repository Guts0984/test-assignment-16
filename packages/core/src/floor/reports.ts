// Period report (ASSIGNMENT shift lead 4): on-time orders, receipt-to-shipment time (median, p90),
// shortages and adjustments by warehouse and employee. Budget: 90 days < 1 s on the full seed.
import { Prisma, type Db } from '@ff/db/client';

export type ReportFilter = {
  readonly from: string;
  readonly to: string;
  readonly warehouseIds: readonly string[] | null;
  readonly staffId?: string;
};

const DAY_MS = 86_400_000;
/** Minutes are shown to two decimals (floating point noise like 456.00000000000006 never leaves the api). */
const round2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);
/**
 * The period is whole local days of each warehouse (its own time zone). The UTC prefilter (+-15 h
 * covers every zone) keeps the time index usable; the exact test is the warehouse-local midnight.
 */
/** Per-warehouse local-day bounds, computed once per warehouse (not once per row). */
const bounds = (f: ReportFilter, col: string) =>
  Prisma.sql`JOIN (
    SELECT id, (${f.from}::date)::timestamp AT TIME ZONE time_zone AS lo,
           (${f.to}::date + 1)::timestamp AT TIME ZONE time_zone AS hi
    FROM warehouses) b ON b.id = ${Prisma.raw(col)}`;
const within = (col: string, f: ReportFilter) => {
  const c = Prisma.raw(col);
  const lo = new Date(Date.parse(`${f.from}T00:00:00Z`) - 15 * 3_600_000);
  const hi = new Date(Date.parse(`${f.to}T00:00:00Z`) + DAY_MS + 15 * 3_600_000);
  return Prisma.sql`${c} >= ${lo} AND ${c} < ${hi} AND ${c} >= b.lo AND ${c} < b.hi`;
};
const whFilter = (col: string, ids: readonly string[] | null) =>
  ids === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(col)} = ANY(${[...ids]}::uuid[])`;

export const periodReport = async (db: Db, f: ReportFilter) => {
  const staff = f.staffId === undefined ? Prisma.empty : Prisma.sql`AND x.person = ${f.staffId}::uuid`;
  const [orders, byWarehouse, shortages, adjustments] = await Promise.all([
    db.$queryRaw<{ shipped: number; on_time: number; median_min: number | null; p90_min: number | null }[]>`
      SELECT count(*)::int AS shipped,
             count(*) FILTER (WHERE o.packed_at < o.target_cutoff_at)::int AS on_time,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.shipped_at - o.received_at) / 60)::float8 AS median_min,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM o.shipped_at - o.received_at) / 60)::float8 AS p90_min
      FROM orders o ${bounds(f, 'o.warehouse_id')} WHERE o.status = 'shipped' AND ${within('o.shipped_at', f)} ${whFilter('o.warehouse_id', f.warehouseIds)}`,
    db.$queryRaw<
      {
        warehouse_id: string;
        code: string;
        shipped: number;
        on_time: number;
        median_min: number | null;
        p90_min: number | null;
      }[]
    >`
      SELECT o.warehouse_id, w.code, count(*)::int AS shipped,
             count(*) FILTER (WHERE o.packed_at < o.target_cutoff_at)::int AS on_time,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.shipped_at - o.received_at) / 60)::float8 AS median_min,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM o.shipped_at - o.received_at) / 60)::float8 AS p90_min
      FROM orders o JOIN warehouses w ON w.id = o.warehouse_id ${bounds(f, 'o.warehouse_id')}
      WHERE o.status = 'shipped' AND ${within('o.shipped_at', f)} ${whFilter('o.warehouse_id', f.warehouseIds)}
      GROUP BY o.warehouse_id, w.code ORDER BY w.code`,
    db.$queryRaw<
      { warehouse_id: string; code: string; person: string; name: string; events: number; units: number }[]
    >`
      SELECT x.warehouse_id, w.code, x.person, s.name, count(*)::int AS events, SUM(x.units)::int AS units
      FROM (SELECT warehouse_id, picker_id AS person, (expected_qty - found_qty) AS units, created_at FROM shortages) x
      JOIN warehouses w ON w.id = x.warehouse_id ${bounds(f, 'x.warehouse_id')} JOIN staff s ON s.id = x.person
      WHERE ${within('x.created_at', f)} ${whFilter('x.warehouse_id', f.warehouseIds)} ${staff}
      GROUP BY x.warehouse_id, w.code, x.person, s.name ORDER BY w.code, s.name`,
    db.$queryRaw<
      { warehouse_id: string; code: string; person: string; name: string; events: number; units: number }[]
    >`
      SELECT x.warehouse_id, w.code, x.person, s.name, count(*)::int AS events, SUM(abs(x.delta))::int AS units
      FROM (SELECT warehouse_id, author_id AS person, delta, created_at FROM adjustments) x
      JOIN warehouses w ON w.id = x.warehouse_id ${bounds(f, 'x.warehouse_id')} JOIN staff s ON s.id = x.person
      WHERE ${within('x.created_at', f)} ${whFilter('x.warehouse_id', f.warehouseIds)} ${staff}
      GROUP BY x.warehouse_id, w.code, x.person, s.name ORDER BY w.code, s.name`,
  ]);
  const total = orders[0] ?? { shipped: 0, on_time: 0, median_min: null, p90_min: null };
  const people = (rows: typeof shortages) =>
    rows.map((r) => ({
      warehouseId: r.warehouse_id,
      warehouseCode: r.code,
      staffId: r.person,
      staffName: r.name,
      events: r.events,
      units: r.units,
    }));
  return {
    period: { from: f.from, to: f.to },
    orders: {
      shipped: total.shipped,
      onTime: total.on_time,
      onTimeRate: total.shipped === 0 ? null : total.on_time / total.shipped,
      medianMinutes: round2(total.median_min),
      p90Minutes: round2(total.p90_min),
    },
    byWarehouse: byWarehouse.map((r) => ({
      warehouseId: r.warehouse_id,
      warehouseCode: r.code,
      shipped: r.shipped,
      onTime: r.on_time,
      medianMinutes: round2(r.median_min),
      p90Minutes: round2(r.p90_min),
    })),
    shortages: people(shortages),
    adjustments: people(adjustments),
  };
};
