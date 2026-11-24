// Period report (ASSIGNMENT shift lead 4): on-time orders, receipt-to-shipment time (median, p90),
// shortages and adjustments by warehouse and employee. Budget: 90 days < 1 s on the full seed.
import { Prisma, type Db } from '@ff/db/client';

export type ReportFilter = {
  readonly from: string;
  readonly to: string;
  readonly warehouseIds: readonly string[] | null;
  readonly staffId?: string;
};

const range = (f: ReportFilter) => ({
  start: new Date(`${f.from}T00:00:00Z`),
  end: new Date(Date.parse(`${f.to}T00:00:00Z`) + 86_400_000),
});
const whFilter = (col: string, ids: readonly string[] | null) =>
  ids === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(col)} = ANY(${[...ids]}::uuid[])`;

export const periodReport = async (db: Db, f: ReportFilter) => {
  const { start, end } = range(f);
  const staff = f.staffId === undefined ? Prisma.empty : Prisma.sql`AND x.person = ${f.staffId}::uuid`;
  const [orders, byWarehouse, shortages, adjustments] = await Promise.all([
    db.$queryRaw<{ shipped: number; on_time: number; median_min: number | null; p90_min: number | null }[]>`
      SELECT count(*)::int AS shipped,
             count(*) FILTER (WHERE o.packed_at < o.target_cutoff_at)::int AS on_time,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.shipped_at - o.received_at) / 60)::float8 AS median_min,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM o.shipped_at - o.received_at) / 60)::float8 AS p90_min
      FROM orders o WHERE o.status = 'shipped' AND o.shipped_at >= ${start} AND o.shipped_at < ${end} ${whFilter('o.warehouse_id', f.warehouseIds)}`,
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
      FROM orders o JOIN warehouses w ON w.id = o.warehouse_id
      WHERE o.status = 'shipped' AND o.shipped_at >= ${start} AND o.shipped_at < ${end} ${whFilter('o.warehouse_id', f.warehouseIds)}
      GROUP BY o.warehouse_id, w.code ORDER BY w.code`,
    db.$queryRaw<
      { warehouse_id: string; code: string; person: string; name: string; events: number; units: number }[]
    >`
      SELECT x.warehouse_id, w.code, x.person, s.name, count(*)::int AS events, SUM(x.units)::int AS units
      FROM (SELECT warehouse_id, picker_id AS person, (expected_qty - found_qty) AS units, created_at FROM shortages) x
      JOIN warehouses w ON w.id = x.warehouse_id JOIN staff s ON s.id = x.person
      WHERE x.created_at >= ${start} AND x.created_at < ${end} ${whFilter('x.warehouse_id', f.warehouseIds)} ${staff}
      GROUP BY x.warehouse_id, w.code, x.person, s.name ORDER BY w.code, s.name`,
    db.$queryRaw<
      { warehouse_id: string; code: string; person: string; name: string; events: number; units: number }[]
    >`
      SELECT x.warehouse_id, w.code, x.person, s.name, count(*)::int AS events, SUM(abs(x.delta))::int AS units
      FROM (SELECT warehouse_id, author_id AS person, delta, created_at FROM adjustments) x
      JOIN warehouses w ON w.id = x.warehouse_id JOIN staff s ON s.id = x.person
      WHERE x.created_at >= ${start} AND x.created_at < ${end} ${whFilter('x.warehouse_id', f.warehouseIds)} ${staff}
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
      medianMinutes: total.median_min,
      p90Minutes: total.p90_min,
    },
    byWarehouse: byWarehouse.map((r) => ({
      warehouseId: r.warehouse_id,
      warehouseCode: r.code,
      shipped: r.shipped,
      onTime: r.on_time,
      medianMinutes: r.median_min,
      p90Minutes: r.p90_min,
    })),
    shortages: people(shortages),
    adjustments: people(adjustments),
  };
};
