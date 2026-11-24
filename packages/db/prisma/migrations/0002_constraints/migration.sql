-- Constraints, triggers and indexes that Prisma's schema language cannot express.
-- These are the database-level guarantees behind the assignment invariants.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- stock balances
-- Invariant 1: never negative; reserved never exceeds on-hand.
ALTER TABLE stock_balances
  ADD CONSTRAINT stock_balances_on_hand_nonneg CHECK (on_hand >= 0),
  ADD CONSTRAINT stock_balances_reserved_nonneg CHECK (reserved >= 0),
  ADD CONSTRAINT stock_balances_reserved_le_on_hand CHECK (reserved <= on_hand);

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_qty_pos CHECK (qty > 0),
  ADD CONSTRAINT stock_movements_has_delta CHECK (on_hand_delta <> 0 OR reserved_delta <> 0);

-- The ledger drives the balances: a movement row and its balance change commit together,
-- and no code path updates stock_balances directly.
-- UPDATE first: INSERT ... ON CONFLICT would evaluate the CHECK constraints against the proposed
-- new row (e.g. on_hand 0, reserved 4) before resolving the conflict (see docs/BUGS_FOUND.md #1).
CREATE FUNCTION apply_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  LOOP
    UPDATE stock_balances
       SET on_hand = on_hand + NEW.on_hand_delta,
           reserved = reserved + NEW.reserved_delta,
           updated_at = now()
     WHERE location_id = NEW.location_id AND sku_id = NEW.sku_id AND batch_id = NEW.batch_id;
    IF FOUND THEN
      RETURN NULL;
    END IF;
    BEGIN
      INSERT INTO stock_balances (location_id, sku_id, batch_id, warehouse_id, on_hand, reserved, updated_at)
      VALUES (NEW.location_id, NEW.sku_id, NEW.batch_id, NEW.warehouse_id, NEW.on_hand_delta, NEW.reserved_delta, now());
      RETURN NULL;
    EXCEPTION WHEN unique_violation THEN
      -- another transaction created the row concurrently: retry the UPDATE, which now waits on its lock
    END;
  END LOOP;
END $$;

CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- The ledger is append-only.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- ---------------------------------------------------------------- locations
ALTER TABLE locations
  ADD CONSTRAINT locations_storage_capacity CHECK (kind <> 'storage' OR (capacity_volume_cm3 > 0 AND capacity_weight_g > 0)),
  ADD CONSTRAINT locations_block_reason CHECK (blocked_reason IS NULL OR blocked_reason IN ('count', 'shortage')),
  ADD CONSTRAINT locations_walk_order_nonneg CHECK (walk_order >= 0),
  ADD CONSTRAINT locations_transit_has_transfer CHECK ((kind = 'transit') = (transfer_id IS NOT NULL));

-- One receiving dock, packing area and return cell per warehouse.
CREATE UNIQUE INDEX locations_one_virtual_per_warehouse ON locations (warehouse_id, kind)
  WHERE kind IN ('receiving', 'packing', 'return');

-- ---------------------------------------------------------------- catalog
ALTER TABLE warehouses
  ADD CONSTRAINT warehouses_cutoff_format CHECK (cutoff_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT warehouses_working_days CHECK (cardinality(working_days) BETWEEN 1 AND 7 AND working_days <@ ARRAY[1,2,3,4,5,6,7]);

ALTER TABLE shops ADD CONSTRAINT shops_min_shelf_life CHECK (min_shelf_life_days BETWEEN 0 AND 3650);

ALTER TABLE skus ADD CONSTRAINT skus_dimensions_pos CHECK (weight_g > 0 AND length_mm > 0 AND width_mm > 0 AND height_mm > 0);

-- A person holds a role at a warehouse at most once; admin is global.
ALTER TABLE staff_roles ADD CONSTRAINT staff_roles_admin_global CHECK ((role = 'admin') = (warehouse_id IS NULL));
CREATE UNIQUE INDEX staff_roles_unique ON staff_roles (staff_id, role, COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- orders
ALTER TABLE order_lines
  ADD CONSTRAINT order_lines_qty_pos CHECK (qty > 0),
  ADD CONSTRAINT order_lines_reserved_nonneg CHECK (reserved_qty >= 0),
  ADD CONSTRAINT order_lines_picked_nonneg CHECK (picked_qty >= 0),
  -- A line can never hold (reserved + picked) more than ordered: no order gets stock twice.
  ADD CONSTRAINT order_lines_reserved_plus_picked_le_qty CHECK (reserved_qty + picked_qty <= qty);

ALTER TABLE order_reservations ADD CONSTRAINT order_reservations_qty_nonneg CHECK (qty >= 0);

CREATE INDEX orders_customer_name_trgm ON orders USING gin (lower(customer_name) gin_trgm_ops);
CREATE INDEX orders_external_number_pattern ON orders (lower(external_number) text_pattern_ops);
CREATE INDEX orders_awaiting ON orders (warehouse_id, received_at) WHERE status = 'awaiting_stock';
CREATE INDEX orders_ready ON orders (warehouse_id, target_cutoff_at) WHERE status = 'reserved';
CREATE INDEX orders_open_by_warehouse ON orders (warehouse_id, status, target_cutoff_at)
  WHERE status NOT IN ('shipped', 'cancelled');
CREATE INDEX skus_code_lower ON skus (lower(code) text_pattern_ops);
CREATE INDEX skus_barcode_lower ON skus (lower(barcode) text_pattern_ops);

-- ---------------------------------------------------------------- waves and picking
-- One active wave per order.
CREATE UNIQUE INDEX wave_orders_one_active ON wave_orders (order_id) WHERE active;
-- One live pick task per order.
CREATE UNIQUE INDEX pick_tasks_one_live ON pick_tasks (order_id) WHERE status IN ('pending', 'assigned');
ALTER TABLE pick_tasks ADD CONSTRAINT pick_tasks_status CHECK (status IN ('pending', 'assigned', 'done', 'cancelled'));
ALTER TABLE pick_tasks ADD CONSTRAINT pick_tasks_assigned_has_assignee CHECK (status <> 'assigned' OR assignee_id IS NOT NULL);

-- Invariant 4: a line is never picked beyond its quantity.
ALTER TABLE pick_lines
  ADD CONSTRAINT pick_lines_qty_pos CHECK (qty > 0),
  ADD CONSTRAINT pick_lines_picked_range CHECK (picked_qty >= 0 AND picked_qty <= qty),
  ADD CONSTRAINT pick_lines_status CHECK (status IN ('open', 'done', 'short', 'cancelled'));

ALTER TABLE pick_scans ADD CONSTRAINT pick_scans_qty_pos CHECK (qty > 0);

-- ---------------------------------------------------------------- counts
-- Invariant 7: one open count per cell.
CREATE UNIQUE INDEX stock_counts_one_open_per_cell ON stock_counts (location_id) WHERE status <> 'closed';
ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_status CHECK (status IN ('open', 'pending_approval', 'closed'));
ALTER TABLE stock_count_lines ADD CONSTRAINT stock_count_lines_nonneg CHECK (system_qty >= 0 AND counted_qty >= 0);
-- Every adjustment has a reason and an author.
ALTER TABLE adjustments
  ADD CONSTRAINT adjustments_reason CHECK (length(btrim(reason)) > 0),
  ADD CONSTRAINT adjustments_delta CHECK (delta <> 0);

-- ---------------------------------------------------------------- jobs and webhooks
ALTER TABLE scheduled_actions ADD CONSTRAINT scheduled_actions_status CHECK (status IN ('pending', 'running', 'done', 'dead'));
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status
  CHECK (status IN ('pending', 'delivering', 'delivered', 'superseded', 'dead'));
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_version_pos CHECK (version > 0);
CREATE INDEX webhook_events_stream ON webhook_events (shop_id, stream, version);

ALTER TABLE test_clock ADD CONSTRAINT test_clock_singleton CHECK (id = 1);
INSERT INTO test_clock (id, offset_ms) VALUES (1, 0);

-- Test clock changes are broadcast so every api and worker process picks them up immediately.
CREATE FUNCTION notify_test_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('test_clock', NEW.offset_ms::text);
  RETURN NULL;
END $$;
CREATE TRIGGER test_clock_notify AFTER UPDATE ON test_clock FOR EACH ROW EXECUTE FUNCTION notify_test_clock();

-- ---------------------------------------------------------------- consistency views
-- Balance vs ledger sum, per (location, sku, batch). Must always be empty.
CREATE VIEW ledger_mismatches AS
SELECT COALESCE(b.location_id, m.location_id) AS location_id,
       COALESCE(b.sku_id, m.sku_id) AS sku_id,
       COALESCE(b.batch_id, m.batch_id) AS batch_id,
       COALESCE(b.on_hand, 0) AS balance_on_hand,
       COALESCE(m.on_hand, 0) AS ledger_on_hand,
       COALESCE(b.reserved, 0) AS balance_reserved,
       COALESCE(m.reserved, 0) AS ledger_reserved
FROM stock_balances b
FULL JOIN (
  SELECT location_id, sku_id, batch_id, SUM(on_hand_delta)::int AS on_hand, SUM(reserved_delta)::int AS reserved
  FROM stock_movements GROUP BY location_id, sku_id, batch_id
) m ON m.location_id = b.location_id AND m.sku_id = b.sku_id AND m.batch_id = b.batch_id
WHERE COALESCE(b.on_hand, 0) <> COALESCE(m.on_hand, 0) OR COALESCE(b.reserved, 0) <> COALESCE(m.reserved, 0);

-- Reserved quantity on a balance vs the reservations that claim it. Must always be empty.
CREATE VIEW reservation_mismatches AS
SELECT COALESCE(b.location_id, r.location_id) AS location_id,
       COALESCE(b.sku_id, r.sku_id) AS sku_id,
       COALESCE(b.batch_id, r.batch_id) AS batch_id,
       COALESCE(b.reserved, 0) AS balance_reserved,
       COALESCE(r.qty, 0) AS reservations_qty
FROM stock_balances b
FULL JOIN (
  SELECT location_id, sku_id, batch_id, SUM(qty)::int AS qty FROM order_reservations GROUP BY 1, 2, 3
) r ON r.location_id = b.location_id AND r.sku_id = b.sku_id AND r.batch_id = b.batch_id
WHERE COALESCE(b.reserved, 0) <> COALESCE(r.qty, 0);

-- Order line reserved_qty vs its reservation rows. Must always be empty.
CREATE VIEW order_line_reservation_mismatches AS
SELECT l.id AS order_line_id, l.reserved_qty, COALESCE(SUM(r.qty), 0)::int AS reservations_qty
FROM order_lines l LEFT JOIN order_reservations r ON r.order_line_id = l.id
GROUP BY l.id, l.reserved_qty
HAVING l.reserved_qty <> COALESCE(SUM(r.qty), 0);
