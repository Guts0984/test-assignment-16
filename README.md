# Fulfillment service for online shops

Several online shops keep stock in our warehouses. A shop sends orders; the warehouse reserves stock, picks with a scanner, packs, prints a label and ships to the carrier. Storekeepers receive deliveries and put goods away, pickers collect orders, a shift lead watches the flow, an admin sets everything up. Shops see their stock and order statuses and get webhooks.

- **Source of truth: PostgreSQL 16** (Prisma, plus raw SQL where locks and constraints matter). Redis 7 only carries disposable state: BullMQ job copies, the Socket.IO adapter, presence and rate-limit counters. Losing all of Redis loses nothing.
- `apps/api` (NestJS, REST + OpenAPI + Socket.IO, two copies behind nginx), `apps/worker` (NestJS, BullMQ, any number of copies), `apps/web` (Next.js 15, React 19, TanStack Query, React Hook Form, Tailwind), `apps/shop-stub` (a demo shop), `packages/shared` (zod schemas and every business rule as pure functions), `packages/db` (schema, migrations, seed), `packages/core` (transactional use-cases shared by api and worker).

## Quick start: open the app and sign in

```bash
cp .env.example .env
docker compose up --build        # first start loads the seed, about a minute
```

Open **http://localhost:8080/login** (if port 8080 is busy on your machine, set `NGINX_HOST_PORT`, `CORS_ORIGINS` and `E2E_BASE_URL` in `.env`) and sign in with any account below. **The password is the same for every account: `demo-password-123`.**

| Role                | Login (email)                                                         | Password            | After sign-in                                               |
| ------------------- | --------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------- |
| Administrator       | `admin@demo.local`                                                    | `demo-password-123` | warehouses, cells, shops, staff, failed jobs (`/admin/...`) |
| Shift lead, Kyiv    | `lead.kyiv@demo.local`                                                | `demo-password-123` | dashboard, waves, shipping, counts, report; also packs      |
| Shift lead, Warsaw  | `lead.warsaw@demo.local`                                              | `demo-password-123` | the same for the Warsaw warehouse                           |
| Storekeeper, Kyiv   | `store.kyiv@demo.local`                                               | `demo-password-123` | receiving, putaway, moves, transfers, shipping              |
| Storekeeper, Warsaw | `store.warsaw@demo.local`                                             | `demo-password-123` | the same for Warsaw                                         |
| Picker, Kyiv        | `picker1.kyiv@demo.local` (also `picker2.kyiv`, `picker3.kyiv`)       | `demo-password-123` | pick screen (scanner, keyboard only)                        |
| Picker, Warsaw      | `picker1.warsaw@demo.local` (also `picker2.warsaw`, `picker3.warsaw`) | `demo-password-123` | pick screen                                                 |
| Packer, Kyiv        | `packer.kyiv@demo.local`                                              | `demo-password-123` | pack screen and label                                       |
| Packer, Warsaw      | `packer.warsaw@demo.local`                                            | `demo-password-123` | pack screen and label                                       |
| Shop cabinet        | `shop1@demo.local` ... `shop5@demo.local` (one per shop)              | `demo-password-123` | SKUs, inbound, orders, live stock                           |

Every address ends with `@demo.local`. The password comes from `SEED_DEMO_PASSWORD` in `.env`.

| Other address              | What it is                                                      |
| -------------------------- | --------------------------------------------------------------- |
| http://localhost:8080/docs | Swagger (OpenAPI JSON at `/docs-json`)                          |
| http://localhost:24000     | demo shop: send orders to the API, see the webhooks it received |

### Shop API keys (for `POST /api/shop/v1/orders` and the other `/api/shop/v1/...` calls)

Send the key as `Authorization: Bearer <key>`. A key sees only its own shop. Keys are derived from `SEED_API_KEY_SALT` in `.env`, so with the example `.env` they are always these (the database stores only hashes):

| Shop                      | API key (header `Authorization: Bearer <key>`) |
| ------------------------- | ---------------------------------------------- |
| SHOP1 Green Leaf Organics | `fk_7d20b33a_Dc8bmjaMh2KYP5w7hWBqF73hosZfJC6V` |
| SHOP2 Urban Gadgets       | `fk_227a99ff_v0A5V6RuSpIgjUJKoDSKsHDHA1KKNKRv` |
| SHOP3 Baby Care Plus      | `fk_34a35857_h2x15YwfeTr6WXmoAIGWNVh2RZRQuaIp` |
| SHOP4 Pet Pantry          | `fk_7b0b71d5_qTGp9RzcxAPpVRpSNSqXtmx5QUSyx7Iu` |
| SHOP5 Home Basics         | `fk_0017ae0d_Kbuo2sM6NVGfOjfq9MCuYdMGbQmNcvcY` |

## 1. Run and test

Start the stack and sign in as described above. The one-shot `migrate` service applies the migrations and the seed (full volume, about 50 seconds) before the api copies, workers, web, the shop stub and nginx start. Postgres and Redis are published on `127.0.0.1:25432` and `127.0.0.1:26379` for running tests from the host; all ports are in `.env`.

### Seed

Full profile (`SEED_PROFILE=full`, the default for compose): 2 warehouses (`KYIV` / `Europe/Kyiv`, `WAW` / `Europe/Warsaw`), 5 shops, 20 000 SKUs (30 % with batches and expiry), 3 000 cells per warehouse, about 1.13 million stock movements, 200 000 orders over a year and about 300 orders in progress (reserved, in a wave, being picked, picked, packed; some of them will miss today's cutoff if nothing is done). Balances are derived from the ledger, so they agree by construction. The seed is one set-based transaction and runs once (`seed_runs` marker, advisory lock). `SEED_PROFILE=small` (200 SKUs, 100 cells per warehouse, 1 000 orders) is used by every test run; the full profile is loaded only by the checks that need size (`scripts/seed-full-check.sql`, `pnpm perf`).

### Tests

```bash
pnpm install
docker compose up -d postgres redis      # real Postgres and Redis for the integration tests
pnpm typecheck && pnpm lint
pnpm test                                # unit tests (shared rules, web model/lib, lint rules)
pnpm test:int                            # integration: real Postgres + Redis, Nest app in-process
pnpm build
pnpm --filter @ff/api test:adversarial   # real nginx + 2 api copies + 3 workers + stub, attacked over the network
pnpm e2e:up && pnpm e2e                  # Playwright on the full compose stack (small seed, test clock)
pnpm perf                                # performance budgets on the full seed (compose up with SEED_PROFILE=full)
pnpm smoke                               # smoke through nginx
pnpm mutation                            # disable protections one by one, tests must fail
pnpm acceptance                          # the 17 acceptance checks, one table
```

Tests never wait for real time: the 15-minute wave, cutoff, expiry dates and the 5-second webhook window run on an injected clock. In the test stack every api and worker process shares one clock (an offset row in Postgres, pushed with LISTEN/NOTIFY) that tests move through a token-protected endpoint that exists only when `TEST_CLOCK_ENABLED=true`.

CI (`.github/workflows/ci.yml`, from the first commit) runs: frozen install, build, **OpenAPI document and generated web client regenerated with `git diff --exit-code`**, typecheck, lint (including the Feature-Sliced Design boundaries and an English-only check), unit tests, integration tests with Postgres and Redis services, the adversarial suite, the Playwright journeys and the full-seed performance job.

## 2. How reservation, FEFO and "stock never goes negative" work

**Order to warehouse.** An order is reserved at **one** warehouse. If some warehouse can cover every line it wins; with several, the nearest to the delivery address (haversine when the address has `lat`/`lon`, otherwise same country before other countries; the warehouse id breaks exact ties). If no warehouse covers everything, the one covering the most units gets a **partial reserve** and the order becomes `awaiting_stock`. If no warehouse holds any of it, the order stays unassigned until some warehouse receives stock.

**FEFO.** For SKUs with expiry tracking the batch that expires first is reserved first (ties: older batch, then batch id, then the cell earliest on the walk route). A batch whose remaining shelf life at the projected shipping day is below the shop's minimum is never reserved; exactly the minimum is allowed, one day less is not. Shelf life is measured at the day the order would ship (the warehouse's shipping day for "now"), not at today's date. A nightly job re-reserves orders whose batch slipped below the minimum since the reserve was made.

**Re-reserve.** When stock becomes reservable (putaway, a return, a finished count, a released reserve) a re-reserve pass runs for that warehouse and SKU: waiting orders are served **express first, then by arrival time**. One pass per (warehouse, SKU) runs at a time (advisory lock); no order gets stock twice because each line is only ever filled up to what it still lacks (`reserved_qty + picked_qty <= qty`, also a `CHECK`).

**Why stock cannot go negative or disappear.**

1. Every stock change is an append-only row in `stock_movements` (what, how much, from, to, who, when, which document). The table cannot be updated or deleted (trigger).
2. `stock_balances` is changed **only by a trigger on the ledger insert**, in the same transaction. There is no other write path, so a balance always equals the sum of its ledger rows (the views `ledger_mismatches`, `reservation_mismatches`, `order_line_reservation_mismatches` must always be empty and every concurrency test and a nightly job check them).
3. `CHECK (on_hand >= 0)`, `CHECK (reserved >= 0)`, `CHECK (reserved <= on_hand)` on every (cell, SKU, batch) row: the database refuses a negative or over-reserved balance even if application code were wrong.
4. Reserve locks the balance rows (`FOR UPDATE`, in a fixed order) before it decides, and cells `FOR SHARE`, so a shortage or a stock count (which lock the cell exclusively) cannot slip in between. Deadlocks and serialization failures are retried a bounded number of times.
5. Putaway checks the cell capacity (volume and weight) under the cell lock; moves lock both cells in id order, so A->B and B->A at once never deadlock.

Transfers between warehouses: the goods leave the cell into a per-transfer `transit` location (a ledger movement), are available at **neither** warehouse, and reach the destination's dock only when it receives them; missing units are written off with a reason.

## 3. Protection against concurrent actions: scan, cancel, stock count

The order row is the first lock in every path that changes an order (scan, cancel, pack, ship, wave, shortage, count relocation); then the pick task, the line, the cell, the balances. One global lock order means no deadlocks between these actions.

- **A scan counts once.** Every scan carries a client-generated idempotency key, claimed with a unique insert in the same transaction as the work (`idempotency_records`, `pick_scans.idempotency_key`). A repeat (double press, resend after a dropped connection) returns the original answer and changes nothing; the same key with a different request is `IDEMPOTENCY_MISMATCH`. Two scans of the last unit with different keys: the second sees the line done (`LINE_COMPLETE`). `pick_lines.picked_qty <= qty` is a `CHECK` as the last guard. Wrong cell, wrong item, wrong batch, a blocked cell and a task that is not yours are refused with distinct codes.
- **Cancel is all or nothing.** Cancel, the last scan and packing all take the order row first. Whichever wins decides: either the order is cancelled and every picked unit moved to the **return cell** (ledger `return`, a putaway task appears) while the reserve is released, or it is `picked`/`packed` and the cancel is refused (`ORDER_NOT_CANCELLABLE`). A cancelled order's later scans get `ORDER_CANCELLED`.
- **Shortage in one transaction.** The cell is locked, what was found is picked, the shortage is recorded, the cell is blocked for picking and putaway (`blocked_reason`), a stock count is opened, and every reservation in that cell is moved to another cell or batch of the same warehouse (FEFO again) with the pick lines following it; if nothing is left the order goes back to `awaiting_stock`. A second picker's scan on that cell waits for the lock and then sees the block.
- **Stock count.** Opening a count locks and blocks the cell; reservations are moved out first. The system quantity is read **under the cell lock** at submit, so a scan that landed before the block is already in it and none can land after. A difference of more than 5 units **or** more than 10 % waits for the shift lead (exactly 5 or exactly 10 % is applied at once); every adjustment has a reason and an author, and a unique partial index allows one open count per cell. The approver is recorded.
- **One wave per order, one wave formation per warehouse** (advisory lock per warehouse, `UNIQUE` on the active wave row of an order): a manual wave and the timer never form two waves for the same orders.
- **Order import** is idempotent per (shop, order number) with a payload hash (`UNIQUE` constraint + `ON CONFLICT`): the same content returns the existing order, different content is `ORDER_CONFLICT`.

## 4. Cutoff and shipping day

Each warehouse has a time zone, working weekdays, an optional list of holiday dates and a local cutoff time (carrier pickup). An order **packed strictly before the cutoff (local time) of a working day ships that day**; exactly at the cutoff or later, or on a non-working day, it ships the **next working day**. All of it is computed from the warehouse's IANA zone (Luxon), so daylight saving is automatic, and always from the **server clock**; the browser's clock is never used (the dashboard measures its offset from the server and counts down to the cutoff with that).

Example, `Europe/Warsaw`, cutoff 17:00, clocks go forward on Sunday 29 March 2026:

| Packed at                    | Local time        | Ships          | Why                                               |
| ---------------------------- | ----------------- | -------------- | ------------------------------------------------- |
| Fri 2026-03-27 16:01Z        | 17:01 CET         | Mon 2026-03-30 | after the cutoff, Saturday and Sunday do not work |
| Fri 2026-03-27 15:57Z        | 16:57 CET         | Fri 2026-03-27 | before the cutoff                                 |
| Mon 2026-03-30 14:59:59.999Z | 16:59:59.999 CEST | Mon 2026-03-30 | 17:00 local is now 15:00Z, not 16:00Z             |
| Mon 2026-03-30 15:00:00Z     | 17:00:00 CEST     | Tue 2026-03-31 | exactly at the cutoff is "after"                  |

A cutoff that falls into the hour skipped by the clock change moves forward by the gap; in the repeated hour in autumn the earlier instant is used. The cases above, both DST nights in Kyiv and Warsaw, a Friday evening and holidays are unit tests of the pure function (`packages/shared/src/time/calendar.spec.ts`); the browser journey E2E-4 and the adversarial suite run the Friday case through the real stack with the test clock.

## 5. Background jobs

Every pending action is a **row in Postgres** (`scheduled_actions`: kind, key, due time, status, lease, attempts; unique per kind and key). BullMQ is a fast path only. The reconciler (in every worker, every `RECONCILE_INTERVAL_MS` and at start) turns due rows into BullMQ jobs with a deterministic job id, and also re-queues rows whose lease expired because their worker was killed. After `FLUSHALL` or a Redis restart the next tick rebuilds every job from Postgres.

A worker **claims** a row with a lease (a conditional `UPDATE ... RETURNING`, so of three workers exactly one wins), runs an idempotent handler, then marks the row finished in a separate, conditional transaction. A crash between the effect and that mark means the row is retried, which is safe because every handler is idempotent (the effect is a no-op the second time). A worker that lost its lease cannot finish the row (the conditional update matches nothing).

| Job (kind, queue)                         | When it is queued                                                                            | Retries / dedup                                                                                             | Recovery                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `reserve_order` (reservation)             | order imported                                                                               | up to `JOB_MAX_ATTEMPTS` with backoff; effect re-checks the order under its lock                            | rebuilt from the row; a killed worker's lease expires                       |
| `rereserve` (reservation)                 | putaway, return, finished count, released reserve                                            | one row per (warehouse, SKU); re-arming while running runs it again once                                    | same                                                                        |
| `wave_check` (waves)                      | an order became ready                                                                        | forms waves while at least 50 orders are ready                                                              | same                                                                        |
| `wave_timer` (waves)                      | one per warehouse, every `WAVE_INTERVAL_MIN` (15) after the last run; a manual wave moves it | empty warehouse = no wave; after downtime exactly one catch-up wave                                         | the row exists even if Redis is empty; created by the reconciler if missing |
| `partial_reserve_expiry` (reserve-expiry) | a partial reserve was made (`PARTIAL_RESERVE_TTL_MIN`)                                       | releases the held stock; the order is then reserved only all-or-nothing                                     | rebuilt from the row                                                        |
| `nightly` (nightly)                       | one per warehouse at `NIGHTLY_LOCAL_TIME` local                                              | shelf-life revalidation, idempotency-key purge, **ledger reconciliation that fails loudly** on any mismatch | rebuilt; failures end up in the failed-jobs list                            |
| `webhook_stream` (webhooks)               | an order changed status or stock changed                                                     | per stream, in version order; `WEBHOOK_MAX_ATTEMPTS` with exponential backoff                               | rebuilt from the outbox rows                                                |
| `import_batch` (order-import)             | `POST /shop/v1/orders/batch`                                                                 | every item uses the same idempotent import                                                                  | rebuilt                                                                     |

A job that used all its attempts becomes `dead`: it is listed for admins (`GET /api/admin/jobs/failed`, the "Failed jobs" screen) with its last error and can be **run again by hand exactly once** (two admins clicking at once: one wins); non-admins get 403. For a webhook stream the dead events are made pending again.

## 6. Webhooks

Events: `order.status_changed` (one stream per order, version = the order's status version) and `stock.available_changed` (one stream per SKU, version = a per-stream counter). They are written as **outbox rows in the same transaction as the change**, so an event cannot be lost or sent for a change that rolled back.

- **Signature:** `X-Fulfillment-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, with a per-shop secret (stored encrypted, shown once). The receiver rejects a bad signature, a timestamp more than 300 s old, and replayed event ids; the demo shop does exactly that. The timestamp is real wall-clock time (a receiver judges it by its own clock).
- **Retries:** exponential backoff (`WEBHOOK_BACKOFF_BASE_MS` doubling up to `WEBHOOK_BACKOFF_MAX_MS`), at most `WEBHOOK_MAX_ATTEMPTS`, then the stream is dead and visible to admins. Redirects are never followed, requests time out, and private/loopback/link-local targets are refused at connect time unless `WEBHOOK_ALLOW_PRIVATE_HOSTS=true` (needed only because the demo shop lives on the private compose network).
- **Order of events:** one in flight per stream (the stream row is locked while delivering), so a later version is never sent before an earlier one; every event has a growing version and the receiver drops anything not newer.
- **Why the shop never sees stale stock:** a stock change only marks the (shop, SKU) stream dirty and schedules **one** send at `max(now, last send + 5 s)`; the payload is built **at send time from the current stock**, so it is always the latest value. Changes inside the window are merged into that one event (at most one event per SKU per 5 s). If a send fails, the next attempt builds a **new event with a new version from the then-current stock** and the older one is marked `superseded`, so an old value is never delivered after a newer one and the shop is stale for at most 5 s plus the retry time.

## 7. Order statuses

`received`, `awaiting_stock`, `reserved`, `in_wave`, `picking`, `picked`, `packed`, `shipped`, `cancelled`. The table below is generated from `packages/shared/src/rules/status.ts` (the same table the api enforces; `pnpm readme-check` fails if it drifts).

<!-- status-table:start -->
| From | To | Who | When |
| --- | --- | --- | --- |
| - | `received` | shop, system | order accepted (API, cabinet or import job) |
| `received` | `reserved` | system | every line reserved at one warehouse |
| `received` | `awaiting_stock` | system | partial or no reserve |
| `awaiting_stock` | `reserved` | system | missing quantity reserved (re-reserve) |
| `reserved` | `awaiting_stock` | system | a count, shortage or shelf-life check moved the reserve away and no stock is left |
| `reserved` | `in_wave` | system, shift_lead | wave formed (timer, 50 ready, or manual) |
| `in_wave` | `awaiting_stock` | system | a count or shortage left no alternative stock |
| `in_wave` | `picking` | picker, shift_lead | a picker takes or is assigned the task |
| `picking` | `picked` | picker | the last line is scanned |
| `picking` | `awaiting_stock` | system | a shortage left no alternative stock |
| `picked` | `packed` | packer, shift_lead | order scanned at packing, label printed |
| `packed` | `shipped` | storekeeper, shift_lead | handed over to the carrier |
| `received` | `cancelled` | shop, admin | cancel: the reserve is released |
| `awaiting_stock` | `cancelled` | shop, admin | cancel: the reserve is released |
| `reserved` | `cancelled` | shop, admin | cancel: the reserve is released |
| `in_wave` | `cancelled` | shop, admin | cancel: the reserve is released |
| `picking` | `cancelled` | shop, admin | cancel: picked goods go to the return cell, the rest of the reserve is released |
| `picked` | `cancelled` | shop, admin | cancel: picked goods go to the return cell, the rest of the reserve is released |
| `packed`, `shipped` | `cancelled` | - | refused with `ORDER_NOT_CANCELLABLE` (see decision D-3); cancelling an already cancelled order is a no-op |
<!-- status-table:end -->

"Who": `shop` is the shop (API key or cabinet), `system` is a worker job, the others are staff roles at that warehouse (an admin may act as any of them).

## 8. Indexes and constraints

Checked against the live database by `pnpm readme-check`.

**Uniqueness and idempotency**

| Name                                                                                                   | Guarantees                                           |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `orders_shop_id_external_number_key`                                                                   | an order number exists once per shop (import dedup)  |
| `skus_shop_id_barcode_key`, `skus_shop_id_code_key`                                                    | barcode and code unique per shop                     |
| `locations_warehouse_id_code_key`                                                                      | cell code unique per warehouse                       |
| `locations_one_virtual_per_warehouse`                                                                  | one dock, packing area and return cell per warehouse |
| `staff_roles_unique`                                                                                   | a role at a warehouse is granted once                |
| `wave_orders_one_active`                                                                               | an order is in at most one active wave               |
| `pick_tasks_one_live`                                                                                  | an order has one live pick task                      |
| `stock_counts_one_open_per_cell`                                                                       | one open count per cell                              |
| `pick_scans_idempotency_key_key`, `receipt_lines_idempotency_key_key`, `transfers_idempotency_key_key` | a scan / receipt line / transfer is applied once     |
| `scheduled_actions_kind_key_key`                                                                       | one pending action per (kind, key)                   |
| `webhook_events_shop_id_stream_version_key`                                                            | one event per stream version (monotonic versions)    |
| `order_lines_order_id_sku_id_key`                                                                      | no duplicate SKU line in an order                    |

**CHECK constraints**

| Name                                                                                                    | Guarantees                                           |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `stock_balances_on_hand_nonneg`, `stock_balances_reserved_nonneg`, `stock_balances_reserved_le_on_hand` | no negative stock, no over-reserve                   |
| `order_lines_reserved_plus_picked_le_qty`                                                               | no order gets stock twice                            |
| `pick_lines_picked_range`                                                                               | a line is never picked beyond its quantity           |
| `stock_movements_qty_pos`, `stock_movements_has_delta`                                                  | every ledger row is a real change                    |
| `locations_storage_capacity`, `locations_block_reason`                                                  | cell capacity > 0, a block has a known reason        |
| `adjustments_reason`, `adjustments_delta`                                                               | every adjustment has a non-blank reason and a change |
| `warehouses_cutoff_format`, `warehouses_working_days`                                                   | `HH:MM` cutoff, weekdays 1-7                         |

**Triggers:** `stock_movements_apply` (ledger insert updates the balance), `stock_movements_append_only` (no update or delete), `test_clock_notify`.

**Indexes for the budgets:** `stock_balances (sku_id, warehouse_id)` (stock per SKU per warehouse), `orders_external_number_pattern` and `skus_code_lower` / `skus_barcode_lower` (search by number and SKU), `orders_customer_name_trgm` (trigram search by customer), `orders_awaiting`, `orders_ready`, `orders_open_by_warehouse` (partial indexes for re-reserve, waves and the dashboard), `stock_movements (location_id, sku_id, batch_id)`, `(doc_type, doc_id)`, `(warehouse_id, kind, created_at)`, `(actor_id, kind, created_at)` (ledger checks and reports), `orders (warehouse_id, shipped_at)` (report period).

Measured on the full seed through nginx (p95 of 30 warm requests; budget in brackets): stock per SKU per warehouse 13 ms (200 ms), order search by number 6 ms / customer 31 ms / SKU 5 ms (300 ms), 90-day report 48 ms (1 s).

## 9. Decisions made where the assignment was silent or ambiguous

The full list with reasons is in `plan.md` (Assumptions and Deviations). The ones that matter:

- **D-3 Cancel and packing.** The scenario says a shop can cancel "until shipped", but invariant 5 says a cancel racing packing must leave either a cancelled order or a packed one with the cancel refused. The stricter rule wins: `packed` and `shipped` orders cannot be cancelled.
- **Statuses and who moves them.** `picking` when a picker takes the task, `picked` on the last scan, `packed` on the packer's scan (the label is made then), `shipped` when a storekeeper or shift lead hands the order to the carrier. The packing area is a virtual location in the ledger, so picked goods are always somewhere.
- **Distance.** "Nearest to the address" uses coordinates when the order's address has them, otherwise same country first.
- **Partial reserve** goes to the warehouse covering the most units. It expires after `PARTIAL_RESERVE_TTL_MIN` (48 h by default); the held stock is released and the order then waits for a **full** reserve, to avoid ping-pong.
- **Stock on the dock is not reservable.** Received goods are reservable after putaway into a cell (the shop sees them separately as "on dock").
- **Waves.** Ready orders at a warehouse sorted by target cutoff, then express, then arrival, up to `WAVE_MAX_ORDERS`. One pick task per order; its lines follow the cell walk order. A manual wave resets the 15-minute timer. "50 ready" counts orders in `reserved` that are not in a wave.
- **At risk.** An order is at risk when the time to its target cutoff is shorter than the typical remaining work for its status plus `AT_RISK_THRESHOLD_MIN`; a passed cutoff is "late". The target cutoff is the cutoff of the earliest day the order could ship.
- **"On time" in the report** means packed before the cutoff of that earliest possible shipping day. The 90-day report is a live indexed query (it measured 48 ms, so no rollup table was needed).
- **Roles.** `admin` (global), `shift_lead`, `storekeeper`, `picker`, `packer` per warehouse, plus shop cabinet users and shop API keys. Packing is also allowed to the shift lead.
- **Sessions.** Access token 15 minutes (in memory only); refresh token in an httpOnly, SameSite=Strict cookie, rotated on every use with reuse detection (a token reused after `REFRESH_REUSE_GRACE_SEC`, 10 s by default, revokes the whole family; inside the window a second presentation, such as two tabs refreshing together, just gets a fresh token. Set it to 0 for strict single use). Roles and the active flag are read from the database on every request, so a removed role or a deactivated employee is locked out immediately. Passwords: argon2id (OWASP minimum cost, so an in-limit login flood stays cheap).
- **API keys** are `fk_<8 hex>_<32 chars>`, stored as an HMAC with a pepper, compared in constant time, shown once, revocable, and scoped to one shop. A shop cabinet user sees exactly what the shop's key sees.
- **Rate limiting** is fixed-window, atomic in Redis (one Lua call), by **real client IP** (nginx overwrites `X-Real-IP`; the api trusts it only from `TRUSTED_PROXY_CIDRS`; IPv6 is bucketed by /64, IPv4-mapped addresses fold into IPv4), by API key for the shop API, and for logins three ways: per IP, per (IP, account) so a stranger cannot lock the owner out, and per account across all IPs (`RATE_LIMIT_LOGIN_PER_ACCOUNT_TOTAL`, a guess budget against distributed attacks; trade-off: an attacker with many addresses can still exhaust it and block that one account for the window). Limits hold across both api copies. **Redis down = fail-open** to a per-process limiter with the same limits (availability over strictness; correctness never depends on the limiter because Postgres guards hold). Every limit and window is an environment variable; the defaults in `.env.example` let all acceptance scenarios (300 simultaneous orders, 10 duplicates, chaos mode, scans, sockets, e2e) through.
- **Realtime.** Rooms are joined only by the server, from the caller's rights: `shop:<id>`, `wh:<id>:lead`, `wh:<id>:floor`, `picker:<id>`. A shop socket never gets staff names, shortages or adjustments. Presence is a Redis key with a TTL refreshed by heartbeats, so it expires when a client vanishes. After a reconnect (for example after Redis was lost) the page refetches from REST. nginx round-robins the api copies; clients use the websocket transport only, so no sticky sessions are needed.
- **Errors.** Every failure, including nginx's own, is `{ "error": { "code", "message", "fields"?, "requestId" } }`, declared on every operation in OpenAPI. Unknown failures are `UNEXPECTED` with no internals. Unknown fields in a body are rejected (mass assignment), JSON bodies only (415), 1 MB limit (413), prototype-pollution keys refused.
- **Inputs.** Orders: 1-500 lines, integer quantity 1-100 000, a SKU once per order, strings bounded and NFC-normalised without control characters. Pagination `limit` 1-200, cursor based. Report periods: from <= to, under 366 days.
- **Batches.** Every SKU has batches; SKUs without expiry use one implicit batch. A SKU with expiry needs a batch code and a future expiry date at receipt, and the same batch code cannot be received with a different expiry.
- **Receiving** works against the shop's inbound request (ASN) or ad hoc; closing a receipt records every difference (over, under, unexpected) and the shop sees it.
- **Label** is an A6 PDF with a Code128 of the order number; the file name is built from the order id only; the PDF is fetched with the user's token and opened in a new tab.
- **Webhook and stock numbers** shown to shops: _on shelf_ (storage cells), _reserved_, _available_ (on shelf minus reserved, not counting blocked cells or batches below the shop's minimum shelf life), _in transit_ (transfers to that warehouse), _on dock_.
- **Compose.** Two api services `api-a` and `api-b` (so tests and the chaos mode can address each copy), one-shot `migrate`, `worker` with `deploy.replicas` (3). nginx has the fixed address `172.31.116.10`, which is the only trusted proxy.
- **Language.** Everything (UI, API messages, seed data, docs) is English, one locale, no i18n framework.
- **Not built:** a rollup table for reports (not needed), holiday calendars per country (a list of dates per warehouse instead).

## 10. Where to look

| Topic                                | Place                    |
| ------------------------------------ | ------------------------ |
| Business rules (pure functions)      | `packages/shared/src`    |
| Transactional use-cases              | `packages/core/src`      |
| Schema, migrations, seed             | `packages/db`            |
| Plan, deviations, acceptance results | `plan.md`                |
| Bugs the tests found                 | `docs/BUGS_FOUND.md`     |
| Attack scenarios and results         | `docs/SECURITY-TESTS.md` |
| Mutation check                       | `docs/MUTATION-CHECK.md` |
