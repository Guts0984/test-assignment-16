-- Full-seed volume check (ASSIGNMENT "Seed"). Run against a database seeded with SEED_PROFILE=full.
-- Fails (division by zero) when any expectation is not met.
SELECT 1 / (
  (SELECT count(*) = 2 FROM warehouses)::int
  * (SELECT count(DISTINCT time_zone) = 2 FROM warehouses)::int
  * (SELECT count(*) = 5 FROM shops)::int
  * (SELECT count(*) = 20000 FROM skus)::int
  * (SELECT count(*) > 0 FROM skus WHERE tracks_expiry)::int
  * (SELECT bool_and(n = 3000) FROM (SELECT count(*) AS n FROM locations WHERE kind = 'storage' GROUP BY warehouse_id) c)::int
  * (SELECT count(*) >= 1000000 FROM stock_movements)::int
  * (SELECT count(*) >= 200000 FROM orders WHERE received_at > now() - interval '366 days')::int
  * (SELECT count(*) BETWEEN 250 AND 350 FROM orders WHERE status NOT IN ('shipped', 'cancelled'))::int
  * (SELECT count(*) = 0 FROM ledger_mismatches)::int
  * (SELECT count(*) = 0 FROM reservation_mismatches)::int
  * (SELECT count(*) = 0 FROM order_line_reservation_mismatches)::int
) AS seed_full_ok;
