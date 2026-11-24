// Set-based seed statements. Deterministic ids (md5(text)::uuid) let every statement join
// without lookups. Ledger rows are written with the balance trigger disabled, then balances
// are rebuilt from the ledger sum, so balances equal the ledger by construction.
import { Prisma } from '@prisma/client';
import { type SeedProfile } from './profiles';

export type SeedParams = { readonly now: Date; readonly profile: SeedProfile };

const FIRST = `ARRAY['Olena','Ivan','Anna','Taras','Maria','Petro','Iryna','Andrii','Kateryna','Oleh','Zofia','Jan','Agnieszka','Piotr','Magda','Tomasz','Ewa','Marek','Natalia','Pawel']`;
const LAST = `ARRAY['Kovalenko','Shevchenko','Bondarenko','Tkachenko','Kravchenko','Nowak','Kowalski','Wisniewski','Wojcik','Kaminski','Lewandowski','Zielinski','Melnyk','Boyko','Moroz','Lysenko','Szymanski','Dabrowski','Kozlowski','Jankowski']`;
const STREETS = `ARRAY['Main St','Oak Ave','Park Rd','Market Sq','River St','Hill Rd','Station St','Garden Ln']`;

/** Warehouses 1 = Kyiv, 2 = Warsaw. */
const WZ = `(VALUES (1, 'Europe/Kyiv', 'UA', 'Kyiv'), (2, 'Europe/Warsaw', 'PL', 'Warsaw')) AS wz(w, tz, cc, city)`;

/** Slot cell of a SKU in a warehouse. */
const cellExpr = (s: string, n: string, w: string, cells: number): string =>
  `md5('cell:' || ${w} || ':' || (1 + ((${s} * 100003 + ${n} * 7 + ${w} * 13) % ${cells})))::uuid`;

const batchExpr = (s: string, n: string, b: string): string => `md5('batch:' || ${s} || ':' || ${n} || ':' || ${b})::uuid`;

export const seedStatements = ({ now, profile: p }: SeedParams): readonly Prisma.Sql[] => {
  const S = p.skusPerShop;
  const C = p.cellsPerWarehouse;
  const H = p.historicOrders;
  const P = p.liveOrdersPerWarehouse;
  const U = p.unstockedEvery;
  const raw = Prisma.raw;
  return [
    Prisma.sql`ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_apply`,
    Prisma.sql`CREATE FUNCTION pg_temp.ship_cutoff(ts timestamptz, tz text) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
      SELECT ((d + CASE
                 WHEN extract(isodow FROM d) BETWEEN 1 AND 5 AND (ts AT TIME ZONE tz)::time < time '17:00' THEN 0
                 ELSE CASE extract(isodow FROM d)::int WHEN 5 THEN 3 WHEN 6 THEN 2 ELSE 1 END
               END) + time '17:00') AT TIME ZONE tz
      FROM (SELECT (ts AT TIME ZONE tz)::date AS d) x $$`,

    // ---------------------------------------------------------------- warehouses and locations
    Prisma.sql`INSERT INTO warehouses (id, code, name, country, time_zone, cutoff_local, working_days, holidays, lat, lon, created_at)
      VALUES (md5('wh:1')::uuid, 'KYIV', 'Kyiv fulfillment center', 'UA', 'Europe/Kyiv', '17:00', '{1,2,3,4,5}', '{}', 50.45, 30.52, ${now}),
             (md5('wh:2')::uuid, 'WAW', 'Warsaw fulfillment center', 'PL', 'Europe/Warsaw', '17:00', '{1,2,3,4,5}', '{}', 52.23, 21.01, ${now})`,
    Prisma.sql`INSERT INTO zones (id, warehouse_id, code, name)
      SELECT md5('zone:' || w || ':' || z)::uuid, md5('wh:' || w)::uuid, chr(64 + z), 'Zone ' || chr(64 + z)
      FROM generate_series(1, 2) w, generate_series(1, 3) z`,
    Prisma.sql`INSERT INTO locations (id, warehouse_id, zone_id, kind, code, walk_order, capacity_volume_cm3, capacity_weight_g, created_at)
      SELECT md5('cell:' || w || ':' || c)::uuid, md5('wh:' || w)::uuid, md5('zone:' || w || ':' || z)::uuid, 'storage',
             chr(64 + z) || '-' || lpad(c::text, 4, '0'), c, 20000000, 5000000, ${now}
      FROM generate_series(1, 2) w, generate_series(1, ${C}::int) c, LATERAL (SELECT 1 + ((c - 1) * 3) / ${C}::int AS z) zz`,
    Prisma.sql`INSERT INTO locations (id, warehouse_id, kind, code, walk_order, created_at)
      SELECT md5('loc:' || w || ':' || k)::uuid, md5('wh:' || w)::uuid, k::location_kind, upper(k), 0, ${now}
      FROM generate_series(1, 2) w, unnest(ARRAY['receiving', 'packing', 'return']) k`,

    // ---------------------------------------------------------------- catalog
    Prisma.sql`INSERT INTO skus (id, shop_id, code, name, barcode, weight_g, length_mm, width_mm, height_mm, tracks_expiry, created_at)
      SELECT md5('sku:' || s || ':' || n)::uuid, md5('shop:' || s)::uuid, 'S' || s || '-' || lpad(n::text, 5, '0'),
             (ARRAY['Organic','Classic','Premium','Eco','Mini','Max','Daily','Fresh'])[1 + n % 8] || ' ' ||
             (ARRAY['tea','coffee','soap','shampoo','vitamins','snack','juice','cream','candle','socks'])[1 + (n / 8) % 10] || ' #' || n,
             '48' || lpad(s::text, 2, '0') || lpad(n::text, 9, '0'),
             50 + (n * 37) % 1950, 20 + (n * 13) % 180, 20 + (n * 17) % 180, 20 + (n * 19) % 180, n % 10 < 3,
             ${now}::timestamptz - interval '400 days'
      FROM generate_series(1, 5) s, generate_series(1, ${S}::int) n`,
    Prisma.sql`INSERT INTO batches (id, sku_id, code, expires_on, received_at)
      SELECT ${raw(batchExpr('s', 'n', 'b'))}, md5('sku:' || s || ':' || n)::uuid,
             CASE WHEN n % 10 < 3 THEN 'L' || lpad(n::text, 5, '0') || '-' || b ELSE '-' END,
             CASE WHEN n % 10 < 3 THEN (${now}::timestamptz::date
               + (CASE WHEN n % 50 = 1 AND b = 1 THEN 10 ELSE 45 + (n * 37 + b * 101) % 400 END)) END,
             ${now}::timestamptz - interval '370 days' + b * interval '1 hour'
      FROM generate_series(1, 5) s, generate_series(1, ${S}::int) n,
           generate_series(1, CASE WHEN n % 10 < 3 THEN 2 ELSE 1 END) b`,

    // ---------------------------------------------------------------- historic orders (all shipped or cancelled)
    Prisma.sql`CREATE TEMP TABLE seed_orders ON COMMIT DROP AS
      SELECT o, md5('order:' || o)::uuid AS id, 1 + o % 5 AS s, wz.w, wz.tz, wz.cc, wz.city, (o % 50 = 0) AS cancelled,
             r.received_at,
             pg_temp.ship_cutoff(r.received_at, wz.tz) AS target_cutoff,
             r.received_at + ((o * 7) % 28 + 1) * interval '1 hour' AS packed_at,
             pg_temp.ship_cutoff(r.received_at + ((o * 7) % 28 + 1) * interval '1 hour', wz.tz) AS shipped_at
      FROM generate_series(1, ${H}::int) o
      JOIN ${raw(WZ)} ON wz.w = 1 + (o / 7) % 2
      CROSS JOIN LATERAL (SELECT ${now}::timestamptz - interval '5 days'
                                 - (o::float8 / ${H}::int * 358) * interval '1 day' - (o % 600) * interval '1 minute' AS received_at) r`,
    Prisma.sql`CREATE TEMP TABLE seed_lines ON COMMIT DROP AS
      SELECT DISTINCT ON (so.o, nn.n) so.o, so.id AS order_id, so.s, so.w, so.cancelled, so.received_at, so.packed_at, so.shipped_at,
             k AS line_no, md5('line:' || so.o || ':' || k)::uuid AS line_id, nn.n,
             md5('sku:' || so.s || ':' || nn.n)::uuid AS sku_id,
             ${raw(batchExpr('so.s', 'nn.n', `(CASE WHEN nn.n % 10 < 3 THEN 1 + so.o % 2 ELSE 1 END)`))} AS batch_id,
             ${raw(cellExpr('so.s', 'nn.n', 'so.w', C))} AS cell_id,
             1 + (so.o + k) % 3 AS qty
      FROM seed_orders so
      CROSS JOIN LATERAL generate_series(1, CASE WHEN so.o % 4 = 0 THEN 2 ELSE 1 END) k
      CROSS JOIN LATERAL (SELECT CASE WHEN m % ${U}::int = 0 THEN CASE WHEN m = ${S}::int THEN m - 1 ELSE m + 1 END ELSE m END AS n
                          FROM (SELECT 1 + ((so.o * 31 + k * 17) % ${S}::int) AS m) mm) nn
      ORDER BY so.o, nn.n, k`,
    Prisma.sql`INSERT INTO orders (id, shop_id, external_number, payload_hash, status, delivery_method, address, customer_name, country,
                                   warehouse_id, received_at, target_cutoff_at, ship_day, packed_at, shipped_at, cancelled_at, status_version, updated_at)
      SELECT so.id, md5('shop:' || so.s)::uuid, 'S' || so.s || '-H' || lpad(so.o::text, 7, '0'), md5('payload:' || so.o),
             (CASE WHEN so.cancelled THEN 'cancelled' ELSE 'shipped' END)::order_status,
             (CASE WHEN so.o % 5 = 0 THEN 'express' ELSE 'standard' END)::delivery_method,
             jsonb_build_object('name', nm.cname, 'line1', (so.o % 300 + 1) || ' ' || (${raw(STREETS)})[1 + so.o % 8],
                                'city', so.city, 'postalCode', lpad((so.o % 99999)::text, 5, '0'), 'country', so.cc),
             nm.cname, so.cc, md5('wh:' || so.w)::uuid, so.received_at, so.target_cutoff,
             CASE WHEN so.cancelled THEN NULL ELSE (so.shipped_at AT TIME ZONE so.tz)::date END,
             CASE WHEN so.cancelled THEN NULL ELSE so.packed_at END,
             CASE WHEN so.cancelled THEN NULL ELSE so.shipped_at END,
             CASE WHEN so.cancelled THEN so.received_at + interval '10 minutes' END,
             CASE WHEN so.cancelled THEN 2 ELSE 7 END, so.received_at
      FROM seed_orders so
      CROSS JOIN LATERAL (SELECT (${raw(FIRST)})[1 + so.o % 20] || ' ' || (${raw(LAST)})[1 + (so.o / 20) % 20] AS cname) nm`,
    Prisma.sql`INSERT INTO order_lines (id, order_id, line_no, sku_id, qty, reserved_qty, picked_qty)
      SELECT line_id, order_id, line_no, sku_id, qty, 0, CASE WHEN cancelled THEN 0 ELSE qty END FROM seed_lines`,
    Prisma.sql`INSERT INTO order_status_history (order_id, version, from_status, to_status, actor_type, created_at)
      SELECT so.id, v.version, v.from_s::order_status, v.to_s::order_status, v.actor, v.at
      FROM seed_orders so
      CROSS JOIN LATERAL (VALUES
        (1, NULL, 'received', 'shop', so.received_at, true),
        (2, 'received', 'cancelled', 'shop', so.received_at + interval '10 minutes', so.cancelled),
        (2, 'received', 'reserved', 'system', so.received_at + interval '5 minutes', NOT so.cancelled),
        (3, 'reserved', 'in_wave', 'system', so.received_at + interval '15 minutes', NOT so.cancelled),
        (4, 'in_wave', 'picking', 'picker', so.packed_at - interval '30 minutes', NOT so.cancelled),
        (5, 'picking', 'picked', 'picker', so.packed_at - interval '20 minutes', NOT so.cancelled),
        (6, 'picked', 'packed', 'packer', so.packed_at, NOT so.cancelled),
        (7, 'packed', 'shipped', 'storekeeper', so.shipped_at, NOT so.cancelled)
      ) AS v(version, from_s, to_s, actor, at, keep)
      WHERE v.keep`,

    // Historic ledger: reserve, pick (cell -> packing), ship.
    Prisma.sql`INSERT INTO stock_movements (group_id, kind, warehouse_id, location_id, sku_id, batch_id, on_hand_delta, reserved_delta, qty,
                                            from_location_id, to_location_id, doc_type, doc_id, actor_type, actor_id, created_at)
      SELECT md5('mv:' || l.line_id || ':' || m.step)::uuid, m.kind::movement_kind, md5('wh:' || l.w)::uuid, m.loc, l.sku_id, l.batch_id,
             m.on_d, m.res_d, l.qty, m.from_loc, m.to_loc, 'order', l.order_id::text,
             m.actor_type, m.actor_id, m.at
      FROM seed_lines l
      CROSS JOIN LATERAL (SELECT md5('loc:' || l.w || ':packing')::uuid AS packing) pk
      CROSS JOIN LATERAL (SELECT
        (SELECT id FROM staff WHERE email = 'picker1.' || (CASE l.w WHEN 1 THEN 'kyiv' ELSE 'warsaw' END) || '@demo.local') AS picker,
        (SELECT id FROM staff WHERE email = 'store.' || (CASE l.w WHEN 1 THEN 'kyiv' ELSE 'warsaw' END) || '@demo.local') AS store) st
      CROSS JOIN LATERAL (VALUES
        ('reserve', 'reserve', l.cell_id, 0, l.qty, l.cell_id, NULL::uuid, 'system', NULL::uuid, l.received_at + interval '5 minutes'),
        ('pick-from', 'pick', l.cell_id, -l.qty, -l.qty, l.cell_id, pk.packing, 'staff', st.picker, l.packed_at - interval '20 minutes'),
        ('pick-to', 'pick', pk.packing, l.qty, 0, l.cell_id, pk.packing, 'staff', st.picker, l.packed_at - interval '20 minutes'),
        ('ship', 'ship', pk.packing, -l.qty, 0, pk.packing, NULL::uuid, 'staff', st.store, l.shipped_at)
      ) AS m(step, kind, loc, on_d, res_d, from_loc, to_loc, actor_type, actor_id, at)
      WHERE NOT l.cancelled`,

    // ---------------------------------------------------------------- receipts covering all sales plus leftover stock
    Prisma.sql`CREATE TEMP TABLE seed_slots ON COMMIT DROP AS
      SELECT s, n, b, w, md5('sku:' || s || ':' || n)::uuid AS sku_id, ${raw(batchExpr('s', 'n', 'b'))} AS batch_id,
             ${raw(cellExpr('s', 'n', 'w', C))} AS cell_id,
             20 + ((s * 31 + n * 17 + b * 7 + w * 3) % 180) AS leftover,
             row_number() OVER (ORDER BY s, n, b, w) AS rn
      FROM generate_series(1, 5) s, generate_series(1, ${S}::int) n,
           generate_series(1, CASE WHEN n % 10 < 3 THEN 2 ELSE 1 END) b, generate_series(1, 2) w
      WHERE n % ${U}::int <> 0`,
    Prisma.sql`CREATE TEMP TABLE seed_receipts ON COMMIT DROP AS
      SELECT sl.*, sl.leftover + COALESCE(sold.qty, 0) AS qty
      FROM seed_slots sl
      LEFT JOIN (SELECT cell_id, sku_id, batch_id, SUM(qty)::int AS qty FROM seed_lines WHERE NOT cancelled GROUP BY 1, 2, 3) sold
        ON sold.cell_id = sl.cell_id AND sold.sku_id = sl.sku_id AND sold.batch_id = sl.batch_id`,
    Prisma.sql`INSERT INTO stock_movements (group_id, kind, warehouse_id, location_id, sku_id, batch_id, on_hand_delta, reserved_delta, qty,
                                            from_location_id, to_location_id, doc_type, doc_id, actor_type, actor_id, created_at)
      SELECT md5('rc:' || r.cell_id || r.batch_id || m.step)::uuid, m.kind::movement_kind, md5('wh:' || r.w)::uuid, m.loc, r.sku_id, r.batch_id,
             m.on_d, 0, r.qty, m.from_loc, m.to_loc, 'seed_receipt', md5('rcpt:' || r.w || ':' || r.s)::text, 'staff', st.store, m.at
      FROM seed_receipts r
      CROSS JOIN LATERAL (SELECT md5('loc:' || r.w || ':receiving')::uuid AS recv) rv
      CROSS JOIN LATERAL (SELECT (SELECT id FROM staff WHERE email = 'store.' || (CASE r.w WHEN 1 THEN 'kyiv' ELSE 'warsaw' END) || '@demo.local') AS store) st
      CROSS JOIN LATERAL (VALUES
        ('receipt', 'receipt', rv.recv, r.qty, NULL::uuid, rv.recv, ${now}::timestamptz - interval '370 days'),
        ('put-from', 'putaway', rv.recv, -r.qty, rv.recv, r.cell_id, ${now}::timestamptz - interval '369 days'),
        ('put-to', 'putaway', r.cell_id, r.qty, rv.recv, r.cell_id, ${now}::timestamptz - interval '369 days')
      ) AS m(step, kind, loc, on_d, from_loc, to_loc, at)`,

    // ---------------------------------------------------------------- historic counts, adjustments and shortages (for reports)
    Prisma.sql`CREATE TEMP TABLE seed_adj ON COMMIT DROP AS
      SELECT i, sl.*, -(1 + i % 5) AS delta, md5('count:' || i)::uuid AS count_id,
             ${now}::timestamptz - interval '2 days' - (i::float8 / ${p.adjustments}::int * 300) * interval '1 day' AS at
      FROM generate_series(1, ${p.adjustments}::int) i
      JOIN seed_slots sl ON sl.rn = 1 + (i * 37) % (SELECT count(*) FROM seed_slots)`,
    Prisma.sql`INSERT INTO stock_counts (id, warehouse_id, location_id, status, origin, assignee_id, created_by, needs_approval, approved_by, created_at, submitted_at, closed_at)
      SELECT a.count_id, md5('wh:' || a.w)::uuid, a.cell_id, 'closed', CASE WHEN a.i % 3 = 0 THEN 'shortage' ELSE 'manual' END,
             st.store, st.lead, false, st.lead, a.at - interval '2 hours', a.at - interval '1 hour', a.at
      FROM seed_adj a
      CROSS JOIN LATERAL (SELECT
        (SELECT id FROM staff WHERE email = 'store.' || (CASE a.w WHEN 1 THEN 'kyiv' ELSE 'warsaw' END) || '@demo.local') AS store,
        (SELECT id FROM staff WHERE email = 'lead.' || (CASE a.w WHEN 1 THEN 'kyiv' ELSE 'warsaw' END) || '@demo.local') AS lead) st`,
    Prisma.sql`INSERT INTO adjustments (warehouse_id, count_id, location_id, sku_id, batch_id, delta, reason, author_id, approved_by, created_at)
      SELECT c.warehouse_id, c.id, c.location_id, a.sku_id, a.batch_id, a.delta,
             (ARRAY['damaged on shelf','miscount at receipt','missing after shortage','expired and removed'])[1 + a.i % 4],
             c.assignee_id, c.approved_by, a.at
      FROM seed_adj a JOIN stock_counts c ON c.id = a.count_id`,
    Prisma.sql`INSERT INTO stock_movements (group_id, kind, warehouse_id, location_id, sku_id, batch_id, on_hand_delta, reserved_delta, qty,
                                            from_location_id, to_location_id, doc_type, doc_id, actor_type, actor_id, reason, created_at)
      SELECT md5('adj:' || a.i)::uuid, 'adjustment', c.warehouse_id, a.cell_id, a.sku_id, a.batch_id, a.delta, 0, -a.delta,
             a.cell_id, NULL, 'stock_count', c.id::text, 'staff', c.assignee_id, 'seed adjustment', a.at
      FROM seed_adj a JOIN stock_counts c ON c.id = a.count_id`,
    Prisma.sql`INSERT INTO shortages (warehouse_id, task_id, line_id, location_id, sku_id, batch_id, picker_id, expected_qty, found_qty, created_at)
      SELECT md5('wh:' || sl.w)::uuid, md5('htask:' || i)::uuid, md5('hline:' || i)::uuid, sl.cell_id, sl.sku_id, sl.batch_id,
             (SELECT id FROM staff WHERE email = 'picker' || (1 + i % 3) || '.' || (CASE sl.w WHEN 1 THEN 'kyiv' ELSE 'warsaw' END) || '@demo.local'),
             2, i % 2, ${now}::timestamptz - interval '1 day' - (i::float8 / ${p.shortages}::int * 300) * interval '1 day'
      FROM generate_series(1, ${p.shortages}::int) i
      JOIN seed_slots sl ON sl.rn = 1 + (i * 53) % (SELECT count(*) FROM seed_slots)`,

    // ---------------------------------------------------------------- ~300 live orders in progress
    Prisma.sql`CREATE TEMP TABLE seed_live ON COMMIT DROP AS
      SELECT i, w, tz, cc, city, s, bucket, md5('live:' || w || ':' || i)::uuid AS id, md5('liveline:' || w || ':' || i)::uuid AS line_id,
             CASE bucket WHEN 0 THEN 'received' WHEN 1 THEN 'awaiting_stock' WHEN 2 THEN 'reserved' WHEN 3 THEN 'reserved'
                         WHEN 4 THEN 'reserved' WHEN 5 THEN 'reserved' WHEN 6 THEN 'in_wave' WHEN 7 THEN 'in_wave' WHEN 8 THEN 'in_wave'
                         WHEN 9 THEN 'picking' WHEN 10 THEN 'picking' WHEN 11 THEN 'picked' WHEN 12 THEN 'picked' ELSE 'packed' END AS status,
             n, md5('sku:' || s || ':' || n)::uuid AS sku_id,
             ${raw(batchExpr('s', 'n', `(CASE WHEN n % 10 < 3 THEN 2 ELSE 1 END)`))} AS batch_id,
             ${raw(cellExpr('s', 'n', 'w', C))} AS cell_id,
             CASE WHEN bucket IN (9, 10) THEN 2 ELSE 1 + i % 2 END AS qty,
             rcv AS received_at, pg_temp.ship_cutoff(rcv, tz) AS target_cutoff
      FROM generate_series(1, ${P}::int) i
      CROSS JOIN ${raw(WZ)}
      CROSS JOIN LATERAL (SELECT 1 + i % 5 AS s, i % 15 AS bucket) bk
      CROSS JOIN LATERAL (SELECT CASE
          WHEN bk.bucket = 1 THEN ${U}::int * (1 + i % greatest(1, ${S}::int / ${U}::int - 1))
          ELSE (SELECT CASE WHEN m % ${U}::int = 0 THEN CASE WHEN m = ${S}::int THEN m - 1 ELSE m + 1 END ELSE m END
                FROM (SELECT 1 + ((i * 13 + w * 7) % ${S}::int) AS m) mm) END AS n) nn
      CROSS JOIN LATERAL (SELECT CASE WHEN i % 7 = 0 THEN ${now}::timestamptz - interval '4 days' - (i % 60) * interval '1 minute'
                                      ELSE ${now}::timestamptz - (i % 300 + 5) * interval '1 minute' END AS rcv) r`,
    Prisma.sql`INSERT INTO orders (id, shop_id, external_number, payload_hash, status, delivery_method, address, customer_name, country,
                                   warehouse_id, received_at, target_cutoff_at, ship_day, packed_at, status_version, updated_at)
      SELECT l.id, md5('shop:' || l.s)::uuid, 'S' || l.s || '-L' || l.w || lpad(l.i::text, 4, '0'), md5('livepayload:' || l.id),
             l.status::order_status, (CASE WHEN l.i % 4 = 0 THEN 'express' ELSE 'standard' END)::delivery_method,
             jsonb_build_object('name', nm.cname, 'line1', (l.i % 90 + 1) || ' Main St', 'city', l.city, 'postalCode', '0' || (1000 + l.i), 'country', l.cc),
             nm.cname, l.cc, CASE WHEN l.status = 'received' THEN NULL ELSE md5('wh:' || l.w)::uuid END,
             l.received_at, CASE WHEN l.status = 'received' THEN NULL ELSE l.target_cutoff END,
             CASE WHEN l.status = 'packed' THEN (pg_temp.ship_cutoff(${now}::timestamptz - interval '3 minutes', l.tz) AT TIME ZONE l.tz)::date END,
             CASE WHEN l.status = 'packed' THEN ${now}::timestamptz - interval '3 minutes' END,
             ver.v, ${now}
      FROM seed_live l
      CROSS JOIN LATERAL (SELECT (${raw(FIRST)})[1 + (l.i * 3) % 20] || ' ' || (${raw(LAST)})[1 + (l.i * 7) % 20] AS cname) nm
      CROSS JOIN LATERAL (SELECT array_position(ARRAY['received','reserved','in_wave','picking','picked','packed'], l.status) AS v0) p0
      CROSS JOIN LATERAL (SELECT CASE WHEN l.status = 'awaiting_stock' THEN 2 ELSE p0.v0 END AS v) ver`,
    Prisma.sql`INSERT INTO order_lines (id, order_id, line_no, sku_id, qty, reserved_qty, picked_qty)
      SELECT line_id, id, 1, sku_id, qty,
             CASE WHEN status IN ('reserved', 'in_wave') THEN qty WHEN status = 'picking' THEN 1 ELSE 0 END,
             CASE WHEN status = 'picking' THEN 1 WHEN status IN ('picked', 'packed') THEN qty ELSE 0 END
      FROM seed_live`,
    Prisma.sql`INSERT INTO order_status_history (order_id, version, from_status, to_status, actor_type, created_at)
      SELECT l.id, v.version, v.from_s::order_status, v.to_s::order_status, v.actor, l.received_at + v.version * interval '1 minute'
      FROM seed_live l
      CROSS JOIN LATERAL (VALUES
        (1, NULL, 'received', 'shop'), (2, 'received', 'awaiting_stock', 'system'), (2, 'received', 'reserved', 'system'),
        (3, 'reserved', 'in_wave', 'system'), (4, 'in_wave', 'picking', 'picker'), (5, 'picking', 'picked', 'picker'),
        (6, 'picked', 'packed', 'packer')) AS v(version, from_s, to_s, actor)
      WHERE v.version = 1
         OR (l.status = 'awaiting_stock' AND v.to_s = 'awaiting_stock')
         OR (l.status NOT IN ('received', 'awaiting_stock') AND v.to_s <> 'awaiting_stock'
             AND v.version <= array_position(ARRAY['received','reserved','in_wave','picking','picked','packed'], l.status))`,
    Prisma.sql`INSERT INTO order_reservations (order_id, order_line_id, location_id, sku_id, batch_id, qty, created_at)
      SELECT id, line_id, cell_id, sku_id, batch_id, CASE WHEN status = 'picking' THEN 1 ELSE qty END, received_at + interval '2 minutes'
      FROM seed_live WHERE status IN ('reserved', 'in_wave', 'picking')`,
    Prisma.sql`INSERT INTO stock_movements (group_id, kind, warehouse_id, location_id, sku_id, batch_id, on_hand_delta, reserved_delta, qty,
                                            from_location_id, to_location_id, doc_type, doc_id, actor_type, actor_id, created_at)
      SELECT md5('livemv:' || l.id || ':' || m.step)::uuid, m.kind::movement_kind, md5('wh:' || l.w)::uuid, m.loc, l.sku_id, l.batch_id,
             m.on_d, m.res_d, m.q, m.from_loc, m.to_loc, 'order', l.id::text, m.actor_type, NULL, l.received_at + m.mins * interval '1 minute'
      FROM seed_live l
      CROSS JOIN LATERAL (SELECT md5('loc:' || l.w || ':packing')::uuid AS packing,
                                 CASE WHEN l.status = 'picking' THEN 1 ELSE l.qty END AS picked) pk
      CROSS JOIN LATERAL (VALUES
        ('reserve', 'reserve', l.cell_id, 0, l.qty, l.qty, l.cell_id, NULL::uuid, 'system', 2, true),
        ('pick-from', 'pick', l.cell_id, -pk.picked, -pk.picked, pk.picked, l.cell_id, pk.packing, 'staff', 4,
          l.status IN ('picking', 'picked', 'packed')),
        ('pick-to', 'pick', pk.packing, pk.picked, 0, pk.picked, l.cell_id, pk.packing, 'staff', 4,
          l.status IN ('picking', 'picked', 'packed'))
      ) AS m(step, kind, loc, on_d, res_d, q, from_loc, to_loc, actor_type, mins, keep)
      WHERE m.keep AND l.status IN ('reserved', 'in_wave', 'picking', 'picked', 'packed')`,
    Prisma.sql`INSERT INTO waves (id, warehouse_id, trigger, order_count, created_at)
      SELECT md5('livewave:' || w)::uuid, md5('wh:' || w)::uuid, 'timer', count(*), ${now}::timestamptz - interval '30 minutes'
      FROM seed_live WHERE status IN ('in_wave', 'picking', 'picked', 'packed') GROUP BY w`,
    Prisma.sql`INSERT INTO wave_orders (wave_id, order_id, active)
      SELECT md5('livewave:' || w)::uuid, id, true FROM seed_live WHERE status IN ('in_wave', 'picking', 'picked', 'packed')`,
    Prisma.sql`INSERT INTO pick_tasks (id, wave_id, order_id, warehouse_id, status, assignee_id, priority_rank, assigned_at, completed_at, created_at)
      SELECT md5('livetask:' || l.id)::uuid, md5('livewave:' || l.w)::uuid, l.id, md5('wh:' || l.w)::uuid,
             CASE l.status WHEN 'in_wave' THEN 'pending' WHEN 'picking' THEN 'assigned' ELSE 'done' END,
             CASE WHEN l.status = 'in_wave' THEN NULL ELSE
               (SELECT id FROM staff WHERE email = 'picker' || (1 + l.i % 2) || '.' || (CASE l.w WHEN 1 THEN 'kyiv' ELSE 'warsaw' END) || '@demo.local') END,
             row_number() OVER (PARTITION BY l.w ORDER BY l.target_cutoff, l.received_at),
             CASE WHEN l.status = 'in_wave' THEN NULL ELSE ${now}::timestamptz - interval '20 minutes' END,
             CASE WHEN l.status IN ('picked', 'packed') THEN ${now}::timestamptz - interval '10 minutes' END,
             ${now}::timestamptz - interval '30 minutes'
      FROM seed_live l WHERE l.status IN ('in_wave', 'picking', 'picked', 'packed')`,
    Prisma.sql`INSERT INTO pick_lines (task_id, order_line_id, location_id, sku_id, batch_id, qty, picked_qty, status, walk_order)
      SELECT md5('livetask:' || l.id)::uuid, l.line_id, l.cell_id, l.sku_id, l.batch_id, l.qty,
             CASE l.status WHEN 'in_wave' THEN 0 WHEN 'picking' THEN 1 ELSE l.qty END,
             CASE WHEN l.status IN ('picked', 'packed') THEN 'done' ELSE 'open' END, loc.walk_order
      FROM seed_live l JOIN locations loc ON loc.id = l.cell_id
      WHERE l.status IN ('in_wave', 'picking', 'picked', 'packed')`,
    Prisma.sql`INSERT INTO scheduled_actions (kind, key, due_at, status, payload)
      SELECT 'reserve_order', id::text, ${now}, 'pending', '{}'::jsonb FROM seed_live WHERE status = 'received'`,

    // ---------------------------------------------------------------- balances from the ledger
    Prisma.sql`INSERT INTO stock_balances (location_id, sku_id, batch_id, warehouse_id, on_hand, reserved, updated_at)
      SELECT location_id, sku_id, batch_id, warehouse_id, SUM(on_hand_delta)::int, SUM(reserved_delta)::int, ${now}
      FROM stock_movements GROUP BY location_id, sku_id, batch_id, warehouse_id`,
    Prisma.sql`ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_apply`,
    Prisma.sql`ANALYZE`,
  ];
};
