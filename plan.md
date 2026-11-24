# plan.md — Fulfillment warehouse for online shops

Status: **Phase 1: building.** See the checklist in section 9.

Sources of truth, highest first: `ASSIGNMENT.md` → this plan (after approval) → `CLAUDE.md` → `.claude/skills/adversarial-testing/SKILL.md` → defaults.

Block IDs (`B1`…`B12`) match the commit plan in §8. Test IDs use these prefixes: `U:` unit (Vitest, pure), `I:` integration (Nest app or core functions against real Postgres + Redis), `A:` adversarial (real servers: nginx + api-a + api-b + 3 workers + shop stub, attacked by a real client over the network), `E:` Playwright e2e (full docker compose), `P:` performance script, `S:` scripted check (shell or CI step), `R:` README review checklist (`scripts/readme-check.ts` greps the README for sections and runs every command in the README's "run" section).

---

## 1. Requirements matrix

### 1.1 Stack

| ID | Requirement (from ASSIGNMENT) | Block | Test |
|---|---|---|---|
| STK-1 | PostgreSQL 16 + Prisma. Raw SQL for locks, constraints and reports. Postgres is the source of truth | B3 | `S: compose uses postgres:16`; `I: db/constraints.int.spec.ts` (CHECKs and uniques reject bad rows); `A: redis-loss.adv.spec.ts` |
| STK-2 | Redis 7 + BullMQ for order import, reservation, wave formation, shop webhooks, reserve expiry and nightly jobs | B5, B9 | `I: worker/queues.int.spec.ts` (each queue exists and processes a job); `A: jobs.adv.spec.ts` |
| STK-3 | Socket.IO adapter between `api` copies | B5 | `A: realtime.adv.spec.ts` (event emitted on api-b reaches a socket on api-a) |
| STK-4 | Losing Redis data loses nothing | B9 | `A: redis-loss.adv.spec.ts` (FLUSHALL and restart) |
| STK-5 | `apps/api`: NestJS, REST + OpenAPI (`@nestjs/swagger`), Socket.IO (`@nestjs/websockets`); two copies behind nginx in compose | B6, B11 | `S: compose config lists api-a, api-b`; `A: nginx-two-copies.adv.spec.ts` (both copies serve traffic); `I: openapi.int.spec.ts` |
| STK-6 | `apps/worker`: separate NestJS process with BullMQ processors; can run several copies | B9 | `A: jobs.adv.spec.ts` (3 copies, no job runs twice) |
| STK-7 | `apps/web`: Next.js 15 App Router, React 19, API client generated from OpenAPI, TanStack Query, React Hook Form, Tailwind | B10 | `S: ci openapi-client-diff`; `U: web/**/*.spec.ts`; `E: *.e2e.ts` |
| STK-8 | `packages/shared`: zod input schemas, FEFO reservation rules, shipping-day and cutoff calculation, status transitions, shared by api, worker and web | B2 | `U: shared/**/*.spec.ts`; `S: lint rule` (api, worker and web import these rules and never re-implement them; `scripts/check-single-source.ts`) |
| STK-9 | Tests: Vitest; integration on real Postgres and Redis; e2e with Playwright | B1+ | `S: CI jobs unit, integration (services postgres:16, redis:7), e2e` |

### 1.2 User scenarios

| ID | Requirement | Block | Test |
|---|---|---|---|
| SHOP-1 | Shop creates SKUs: name, barcode, weight, dimensions, batch + expiry tracking yes/no | B6 | `I: skus.int.spec.ts` (create, duplicate barcode in the same shop gives 409, the same barcode in another shop is allowed, field validation); `E: shop-cabinet.e2e.ts` |
| SHOP-2 | Shop sends orders by API: lines, address, delivery method (standard/express), its own order number | B6 | `I: orders-import.int.spec.ts`; `A: inbound-orders.adv.spec.ts` |
| SHOP-3 | Shop sees stock per SKU per warehouse: on shelf, reserved, available, in transit between warehouses | B6, B8 | `I: stock-view.int.spec.ts` (each column after receipt, reserve, pick, transfer); `P: stock < 200 ms` |
| SHOP-4 | Shop sees each order's status and history, and can cancel until shipped (see Deviation D-3 about `packed`) | B6, B8 | `I: order-history.int.spec.ts`; `I: cancel.int.spec.ts` |
| SHOP-5 | Shop receives webhooks for order status changes and available-stock changes | B9 | `A: webhooks.adv.spec.ts` |
| STK-K1 | Storekeeper receives a delivery: scans product, enters qty, batch and expiry when tracked; mismatch with the shop's inbound request (ASN) is recorded | B8 | `I: receiving.int.spec.ts` (over/under/unexpected SKU recorded as discrepancy rows; expiry required only when tracked) |
| STK-K2 | Putaway: system suggests a cell (same batch, free space), storekeeper scans the cell and confirms | B8 | `U: shared/putaway-suggest.spec.ts`; `I: putaway.int.spec.ts` (capacity by volume and weight, blocked cells skipped, wrong cell scan rejected) |
| STK-K3 | Moves between cells; transfer to another warehouse | B8 | `I: moves.int.spec.ts`; `I: transfers.int.spec.ts`; `A: race-moves.adv.spec.ts` (A→B vs B→A, no raw deadlock) |
| PICK-1 | Picker takes the next task from a wave and sees the route through cells in walk order | B8 | `U: shared/route.spec.ts`; `I: picking-take.int.spec.ts` (SKIP LOCKED, two pickers never get the same task) |
| PICK-2 | Scan cell, then product; system checks product and batch | B8 | `I: picking-scan.int.spec.ts` (WRONG_CELL, WRONG_SKU, WRONG_BATCH, OUT_OF_ORDER) |
| PICK-3 | "Not enough in cell": shortage is recorded, picking continues from another cell if stock exists | B8 | `I: shortage.int.spec.ts`; `E: shortage.e2e.ts` |
| PICK-4 | Picked goods go to packing; packer scans the order, system prints a PDF label | B8 | `I: packing.int.spec.ts`; `I: label-pdf.int.spec.ts` (valid PDF, contains order no. and ship day, escaped text) |
| LEAD-1 | Live flow: orders by status, waves, who picks what, orders at risk of missing cutoff | B8, B10 | `I: dashboard.int.spec.ts`; `A: realtime.adv.spec.ts`; `E: shift-dashboard.e2e.ts` |
| LEAD-2 | Start a wave manually; reassign pick tasks | B8 | `I: waves-manual.int.spec.ts`; `A: race-wave.adv.spec.ts` (manual vs timer); `A: race-reassign.adv.spec.ts` |
| LEAD-3 | Assign and close cell stock counts; approve stock adjustments | B8 | `I: stock-count.int.spec.ts` |
| LEAD-4 | Report for a period: on-time orders, receipt→ship time (median, p90), shortages and adjustments by warehouse and employee. Period and filters in the URL | B8, B10 | `I: reports.int.spec.ts` (known fixture, exact median and p90); `P: report 90d < 1 s`; `E: report-url-state.e2e.ts` |
| ADM-1 | Create warehouses (time zone, working days, carrier cutoff), zones, cells (volume and weight capacity, walk order) | B6 | `I: warehouses.int.spec.ts` (invalid tz, `25:00`, empty working days, capacity ≤ 0 rejected) |
| ADM-2 | Connect shops: API key, webhook URL, minimum remaining shelf life at shipment | B6 | `I: shops.int.spec.ts`; `A: api-keys.adv.spec.ts` |
| ADM-3 | Manage staff and their roles per warehouse | B6 | `I: staff.int.spec.ts`; `A: authz.adv.spec.ts` |

### 1.3 Rules

| ID | Rule | Block | Test |
|---|---|---|---|
| RUL-1 | Reserve at one warehouse: first where all lines are covered; tie → nearest to the address; nowhere enough → partial reserve + `awaiting_stock` | B2, B8 | `U: shared/warehouse-select.spec.ts` (full beats partial, distance tie-break, deterministic id tie-break, partial picks max coverage); `I: reserve.int.spec.ts` |
| RUL-2 | FEFO for expiry-tracked SKUs; a batch with remaining shelf life below the shop minimum is not reserved | B2, B8 | `U: shared/fefo.spec.ts` (equal expiries, boundary exactly at the minimum, ±1 day); `A: acceptance-04.adv.spec.ts` |
| RUL-3 | Re-reserve on receipt: `awaiting_stock` orders get stock automatically, express first, then by arrival time | B2, B8, B9 | `U: shared/rereserve-priority.spec.ts`; `A: acceptance-05.adv.spec.ts` |
| RUL-4 | Wave every 15 min, or immediately at 50 ready orders at a warehouse; nearest cutoff and express first | B2, B9 | `U: shared/wave.spec.ts` (49/50/51, 14:59.999 vs 15:00, priority ordering); `A: waves.adv.spec.ts` |
| RUL-5 | A task line is never picked twice; scanning a wrong cell, product or batch is rejected | B8 | `A: acceptance-06.adv.spec.ts`; `I: picking-scan.int.spec.ts` |
| RUL-6 | Shortage: cell goes to stock count, closed for picking and putaway; reserve moves to another cell or batch at this warehouse if stock exists, else order → `awaiting_stock` | B8 | `A: acceptance-08.adv.spec.ts` |
| RUL-7 | Stock count: cell locked until closed; discrepancy > 5 units or > 10% needs shift-lead approval; every adjustment has a reason and an author | B2, B8 | `U: shared/count-threshold.spec.ts` (5, 6, 10%, 10.01%, system = 0); `A: acceptance-09.adv.spec.ts` |
| RUL-8 | Cancel: before picking → release reserve; during picking → picked goods go to the return cell and are put away again; after shipment → refused | B8 | `I: cancel.int.spec.ts` (each status); `A: acceptance-07.adv.spec.ts` |
| RUL-9 | Cutoff: packed before the warehouse cutoff (local time) ships today, otherwise next warehouse working day; `Europe/Kyiv`, `Europe/Warsaw`, DST handled | B2 | `U: shared/shipping-day.spec.ts` (both DST nights in both zones, 16:59:59.999 / 17:00:00 / 17:00:00.001, Friday 17:01, holidays, non-working day packing); `A: acceptance-10.adv.spec.ts`; `E: cutoff-dst.e2e.ts` |
| RUL-10 | Transfer: stock in transit is available nowhere; at the destination it becomes available after receipt | B8 | `I: transfers.int.spec.ts` (available at src and dst while in transit; dst becomes available only after receipt + putaway) |
| RUL-11 | Webhooks: HMAC-signed; retries with backoff; per-SKU stock changes at most once per 5 s with the latest value; every event has an increasing version | B2, B9 | `U: shared/webhook-coalesce.spec.ts` (4.999 s vs 5.000 s); `A: webhooks.adv.spec.ts` |
| RUL-12 | Order import: the same shop order number sent again is created once; same number with different content → error | B6 | `I: orders-import.int.spec.ts`; `A: acceptance-11.adv.spec.ts` |

### 1.4 Order statuses and movement ledger

| ID | Requirement | Block | Test |
|---|---|---|---|
| ST-1 | Statuses `received, awaiting_stock, reserved, in_wave, picking, picked, packed, shipped, cancelled` | B2, B3 | `U: shared/status.spec.ts` (exhaustive from×to×actor matrix against the table in §3.A); `I: db enum` |
| ST-2 | Transition table (who, from which status) in README | B12 | `R: readme-check` (the table in the README is generated from `packages/shared/status` by `scripts/gen-status-table.ts`, and CI diffs it) |
| LED-1 | Every stock change (receipt, putaway, reserve, unreserve, pick, ship, move, transfer, adjustment) is its own row: what, qty, from, to, who, when, document | B3 | `I: ledger.int.spec.ts` (each operation writes the expected rows with all fields non-null where required) |
| LED-2 | Current stock always equals the ledger sum | B3, all | `ledger.assertBalanced()` at the end of every concurrency test; `I: ledger-balance-fn.int.spec.ts`; nightly reconciliation job `I: nightly.int.spec.ts` |

### 1.5 Seed

| ID | Requirement | Block | Test |
|---|---|---|---|
| SEED-1 | 2 warehouses in two time zones (Kyiv, Warsaw) | B4 | `I: seed.int.spec.ts` (small profile; counts per env) |
| SEED-2 | 5 shops | B4 | same |
| SEED-3 | 20 000 SKUs, some expiry-tracked | B4 | `I: seed.int.spec.ts` on small (shape and ratios); counts checked by `S: seed-full-check.sql` in the `perf-full-seed` CI job only |
| SEED-4 | 3 000 cells per warehouse | B4 | same |
| SEED-5 | 1 000 000 movements and 200 000 orders over a year | B4 | same |
| SEED-6 | ~300 orders in progress (reserve, waves, picking), some will miss today's cutoff if nothing is done | B4 | same + `I: dashboard.int.spec.ts` (at-risk list is non-empty after seed) |
| SEED-7 | Logins and API keys in README | B4, B12 | `A: seed-credentials.adv.spec.ts` (every credential in the README logs in or authenticates) |
| SEED-8 | Seed is consistent with the ledger and idempotent (CLAUDE.md) | B4 | `I: seed.int.spec.ts` (run twice → same counts; `assertBalanced`) |

### 1.6 Shop stub

| ID | Requirement | Block | Test |
|---|---|---|---|
| STUB-1 | Separate compose service | B7, B11 | `S: compose config` |
| STUB-2 | Sends orders: page button (one or a batch of N) and by HTTP (used by tests) | B7 | `I: shop-stub/send.int.spec.ts`; `E: order-flow.e2e.ts` (clicks the button) |
| STUB-3 | Receives webhooks, verifies the signature, shows them on a page with versions | B7 | `U: shop-stub/verify.spec.ts` (tampered body, wrong secret, stale timestamp, replay); `E: order-flow.e2e.ts` |
| STUB-4 | Chaos mode (`.env` switch): order sent twice at once to both api copies | B7 | `A: acceptance-11.adv.spec.ts` |
| STUB-5 | Chaos: every fifth webhook gets 500 or timeout | B7 | `U: shop-stub/chaos.spec.ts` (deterministic pattern); `A: acceptance-11.adv.spec.ts` |
| STUB-6 | Chaos: sometimes a cancel arrives right after the order | B7 | `A: inbound-orders.adv.spec.ts` (chaos cancel lands in a clean state) |

### 1.7 Invariants (each must hold under concurrency, retries, process restart and Redis loss)

| ID | Invariant | Block | Test |
|---|---|---|---|
| INV-1a | Stock never negative per cell | B3, B8 | DB CHECK + `I: constraints`; `A: stock-never-negative.adv.spec.ts` (parallel picks, moves, adjustments) |
| INV-1b | … per batch | B3, B8 | same (assert per-batch sums ≥ 0) |
| INV-1c | … per SKU per warehouse | B3, B8 | same |
| INV-1d | Stock never lost: current = ledger sum | B3 | `assertBalanced` everywhere; `A: acceptance-13.adv.spec.ts` |
| INV-2 | 300 simultaneous orders for one SKU with 100 on hand, through both api copies and 3 workers → exactly 100 reserved, rest `awaiting_stock`, FEFO respected | B8, B9 | `A: acceptance-03.adv.spec.ts` (run in a loop ×5) |
| INV-3 | Receipt with 50 waiting orders → express and earliest get stock; no order gets stock twice | B8, B9 | `A: acceptance-05.adv.spec.ts`; plus two receipts in parallel; cancel racing re-reserve |
| INV-4a | Two pickers scan the same line at once → one scan counted | B8 | `A: acceptance-06.adv.spec.ts` |
| INV-4b | Repeating the same scan (double press, resend after a dropped connection) changes nothing | B8 | same (same idempotency key ×10 across both copies → 1 movement; returns the original result) |
| INV-5 | Cancel at the moment of the last scan or of packing → either cancelled with everything in the return cell, or packed and the cancel refused; never half | B8 | `A: acceptance-07.adv.spec.ts` (cancel vs last scan, cancel vs pack, loop ×50) |
| INV-6 | Shortage → cell blocked and reserve moved in the same transaction; another picker cannot take from that cell | B8 | `A: race-shortage.adv.spec.ts` (shortage vs a second picker's scan on the same cell) |
| INV-7 | Stock count starting on a cell being picked → the scan either lands before the lock and is counted, or is rejected; discrepancy computed from the right balance | B8 | `A: acceptance-09.adv.spec.ts` (loop) |
| INV-8 | One order sent 10× at once to both api copies → one order, one reserve | B6, B8 | `A: acceptance-11.adv.spec.ts` |
| INV-9a | Webhooks: on shop errors every event arrives after retries | B9 | `A: webhooks.adv.spec.ts` (counted at the stub) |
| INV-9b | Stock webhooks never arrive with versions going backwards | B9 | same |
| INV-9c | The shop never sees stock that is gone for longer than 5 s + retry time | B9 | same (staleness measured at the stub with the test clock) |
| INV-10a | `kill -9` worker mid-reserve or mid-wave → after restart all done, no double reserves or double waves | B9 | `A: acceptance-12.adv.spec.ts` |
| INV-10b | Several worker copies never run the same job twice | B9 | `A: jobs.adv.spec.ts` (3 copies, the same job enqueued on all; effect once) |
| INV-10c | A job that exhausted its attempts is visible to admin and can be rerun manually | B9, B10 | `A: jobs-admin.adv.spec.ts` (non-admin 403; rerun once only); `E: admin-failed-jobs.e2e.ts` |
| INV-11 | After `FLUSHALL`, wave timers, re-reserves, webhooks and expiries continue; nothing runs twice | B9 | `A: redis-loss.adv.spec.ts` (FLUSHALL + Redis restart) |
| INV-12a | Shop sees only its own SKUs, orders and stock (cabinet and API key) | B6+ | `A: authz.adv.spec.ts` (IDOR matrix) |
| INV-12b | Employee sees only their warehouses | B6+ | same |
| INV-12c | Picker sees only their own tasks | B8 | same |
| INV-12d | Bad input → clear error with a code, one format for all endpoints, described in OpenAPI; never "Internal server error" | B6 | `A: input-fuzz.adv.spec.ts` (iterates the route table); `I: openapi.int.spec.ts` (every operation declares the error schema) |
| INV-12e | Rights also enforced in sockets | B5, B8 | `A: socket-authz.adv.spec.ts` |
| INV-T | Times in jobs (15-min wave, cutoff, expiry, 5-s webhook window) are replaceable in tests | B2, B5 | shared test clock used by all A-tests; `A: test-clock.adv.spec.ts` (endpoint 404 unless enabled) |

### 1.8 Deliverables

| ID | Requirement | Block | Test |
|---|---|---|---|
| DEL-1 | Repo has `apps/api`, `apps/worker`, `apps/web`, `packages/shared` | B1 | `S: ls` in CI |
| DEL-2 | `cp .env.example .env && docker compose up --build` runs everything | B11 | `S: scripts/compose-smoke.sh` (clean clone, up, wait healthy, smoke through nginx) |
| DEL-3 | Compose services: `postgres`, `redis`, `api` ×2, `nginx`, `worker`, `web`, shop stub | B11 | `S: compose config --services` check |
| DEL-4 | Migrations and seed run on their own, no manual steps | B11 | `S: compose-smoke.sh` |
| DEL-5 | Swagger at `/docs` | B6 | `A: nginx-two-copies.adv.spec.ts` (GET /docs through nginx 200) |
| DEL-6 | Generated client matches the schema, checked in CI | B6, B10 | `S: CI job openapi-client-diff` |
| DEL-7 | Picker screen works with a scanner (keyboard + Enter), no mouse; bad scan → sound + clear message | B10 | `E: scanner-keyboard.e2e.ts` (keyboard only; asserts the AudioContext beep spy and the message); `U: web/features/scan` |
| DEL-8 | Shift dashboard and shop stock update live; time to cutoff uses the server clock | B10 | `E: live-updates.e2e.ts`; `U: web/shared/lib/server-time.spec.ts` (client clock skew ignored) |
| DEL-9 | Forms show field errors | B10 | `E: forms.e2e.ts`; `U: web zod-to-field mapping` |
| DEL-10 | Performance budgets (see NFR-1..3) | B11 | `P:` |
| DEL-11 | Four e2e journeys (see E2E-1..4) | B11 | `E:` |
| DEL-12 | README with listed sections (see RM-*) | B12 | `R:` |

### 1.9 E2E journeys (Playwright on the full compose stack)

| ID | Journey | Block | Test |
|---|---|---|---|
| E2E-1 | Order from shop stub → reserve → wave → scanner picking → packing → label → shipping → shop got status webhooks | B11 | `E: order-flow.e2e.ts` |
| E2E-2 | Shortage during picking → cell under stock count → order picked from another cell | B11 | `E: shortage.e2e.ts` |
| E2E-3 | Order `awaiting_stock` → receipt → order reserved → shop sees new stock | B11 | `E: awaiting-receipt.e2e.ts` |
| E2E-4 | Order packed after cutoff → clock change (DST) → ships on the next warehouse working day | B11 | `E: cutoff-dst.e2e.ts` (test clock) |

### 1.10 README sections

| ID | Section | Block | Test |
|---|---|---|---|
| RM-1 | Run and tests | B12 | `R:` commands run |
| RM-2 | How reserve and FEFO work, and why stock never goes negative | B12 | `R:` |
| RM-3 | How scan, cancel and stock count are protected from concurrent actions | B12 | `R:` |
| RM-4 | How cutoff and ship day are computed, with a DST example | B12 | `R:` example is the same as a `U:` test case (asserted by `readme-check`) |
| RM-5 | Background jobs: when queued, retries, dedup, recovery after Redis loss | B12 | `R:` |
| RM-6 | Webhook delivery and why the shop never sees stale stock | B12 | `R:` |
| RM-7 | Order status table | B12 | `R:` generated from shared, diffed in CI |
| RM-8 | DB indexes and constraints | B12 | `R:` cross-checked against `pg_indexes` / `pg_constraint` by `readme-check` |
| RM-9 | Decisions made | B12 | `R:` every §3 assumption ID appears |
| RM-10 | Logins and API keys | B4, B12 | `A: seed-credentials.adv.spec.ts` |

### 1.11 Acceptance checks (results recorded in §10)

| # | Check | Expected | Test |
|---|---|---|---|
| ACC-1 | `cp .env.example .env && docker compose up --build` | Everything starts | `S: scripts/compose-smoke.sh` |
| ACC-2 | Typecheck, lint, client unchanged, tests, CI | Green on every commit | `S: scripts/verify-history.sh` (checks out each commit in a worktree and runs the CI commands) |
| ACC-3 | 300 simultaneous orders, stock 100, 3 workers | 100 reserved, 200 waiting, nothing negative | `A: acceptance-03.adv.spec.ts` |
| ACC-4 | Batches at 10/40/90 days, shop minimum 30 | Reserve from "40", "10" untouched | `A: acceptance-04.adv.spec.ts` |
| ACC-5 | Receipt of 20 with 50 waiting (some express) | Express and earliest get stock; ledger balances | `A: acceptance-05.adv.spec.ts` |
| ACC-6 | Two pickers scan one line; repeated scan | One scan counted | `A: acceptance-06.adv.spec.ts` |
| ACC-7 | Cancel at the moment of the last scan | Cancelled with all in the return cell, or picked and cancel refused | `A: acceptance-07.adv.spec.ts` |
| ACC-8 | Shortage during picking | Cell blocked; picked from another cell or waiting | `A: acceptance-08.adv.spec.ts` |
| ACC-9 | Count on a cell being picked; discrepancy 7 | Count correct, adjustment awaits shift-lead approval | `A: acceptance-09.adv.spec.ts` |
| ACC-10 | Packed 17:01, cutoff 17:00, Friday, Warsaw | Ships Monday (next working day) | `A: acceptance-10.adv.spec.ts` + `U:` |
| ACC-11 | One order 10× to both copies; shop chaos mode | One order, one reserve; all webhooks delivered; versions never go back | `A: acceptance-11.adv.spec.ts` |
| ACC-12 | `kill -9` worker during wave formation; `FLUSHALL` with live timers | All done, no extra waves or reserves | `A: acceptance-12.adv.spec.ts` |
| ACC-13 | Ledger sum vs current stock after all checks | Matches per cell and batch | `A: acceptance-13.adv.spec.ts` (runs last, over the whole DB) |
| ACC-14 | Lead on copy A, picker on copy B; scan and status change | Seen in < 1 s | `A: acceptance-14.adv.spec.ts` |
| ACC-15 | Another shop's order, another warehouse, another picker's task: direct requests, other shop's API key, socket | Refused | `A: acceptance-15.adv.spec.ts` |
| ACC-16 | Stock, search, 90-day report; reload, "Back" | Fast; state from URL | `P: perf.spec.ts` + `E: report-url-state.e2e.ts` |
| ACC-17 | README | Matches behavior | `R: readme-check` + manual review logged in §10 |

`pnpm acceptance` runs ACC-3…15 (adversarial suite, tagged `@acc-N`), then the perf script and the URL-state e2e, and prints a table. ACC-1 and ACC-2 are shell scripts. ACC-17 is `readme-check` plus a manual walk-through.

### 1.12 Non-functional requirements

| ID | Requirement | Block | Test |
|---|---|---|---|
| NFR-1 | Stock per SKU by warehouse on full seed < 200 ms | B6, B11 | `P: perf.spec.ts` (p95 over 30 runs, warm, through nginx) |
| NFR-2 | Order search by number, customer, SKU < 300 ms | B6, B11 | same |
| NFR-3 | 90-day report < 1 s | B8, B11 | same |
| NFR-4 | Scanner screen: keyboard only, autofocus, focus recovery, Enter submits, sound on error, clear message | B10 | `E: scanner-keyboard.e2e.ts` |
| NFR-5 | Live updates < 1 s across api copies | B5, B8 | `A: acceptance-14.adv.spec.ts` |
| NFR-6 | Time to cutoff by server clock | B6, B10 | `I: GET /time` returns server (test) time; `U: web server-time offset` |
| NFR-7 | Report period, filters, search and pagination in URL; survive reload and Back | B10 | `E: report-url-state.e2e.ts` |
| NFR-8 | Field-level form errors | B10 | `E: forms.e2e.ts` |
| NFR-9 | Locales: the assignment requires none. One UI locale (English), see A-30 | B10 | n/a (logged) |
| NFR-10 | Same error format on every endpoint, in OpenAPI, never a bare 500 | B6 | `A: input-fuzz.adv.spec.ts` |

### 1.13 Rate limiter (CLAUDE.md requirement)

| ID | Requirement | Block | Test |
|---|---|---|---|
| RL-1 | Limit by real client IP (and by account / API key where relevant), Redis atomic Lua, shared across both api copies | B5, B6 | `A: rate-limit.adv.spec.ts` (total across copies, N parallel never exceed) |
| RL-2 | Flood from IP X does not lock out IPs Y, Z; they keep 2xx with p95 < 150 ms | B5 | same |
| RL-3 | Spoofed `X-Forwarded-For` / `X-Real-IP` / `Forwarded` cannot evade the limit or frame a victim; trusted only from nginx | B5, B11 | same |
| RL-4 | Window boundaries, off-by-one, recovery, `Retry-After` correct, keys have a TTL, IPv6 /64 and IPv4-mapped normalisation | B5 | `U: client-ip.spec.ts`; `A: rate-limit.adv.spec.ts` |
| RL-5 | Redis down → documented behavior (A-22) | B5 | `A: rate-limit.adv.spec.ts` (redis stopped) |
| RL-6 | Never blocks the acceptance flows (#3 300 orders, #11 duplicates, chaos mode, scans, sockets, e2e) with `.env.example` limits | B5, B11 | ACC-3/11/14 run with the default limits; `A: rate-limit-acceptance.adv.spec.ts` |
| RL-7 | Socket message flood throttled per socket without affecting others | B5 | `A: socket-authz.adv.spec.ts` |

---

## 2. Deviations

I found no direct conflict between ASSIGNMENT.md and CLAUDE.md. The items below are places where I had to bend one of the documents, or where the assignment contradicts itself. The assignment wins in every case.

| ID | Conflict | Resolution |
|---|---|---|
| D-1 | ASSIGNMENT lists the compose services `postgres, redis, api ×2, nginx, worker, web, shop stub`. Migrations and seed must run "by themselves" | Added a **one-shot `migrate` container**, built from the api image. It runs `prisma migrate deploy` and then the idempotent seed, and exits. The long-running services wait for it (`service_completed_successfully`). It is not an extra long-running service. The alternative was to migrate inside api startup under an advisory lock, which would delay both api healthchecks by the full seed time. |
| D-2 | "api ×2": compose `deploy.replicas` copies cannot be addressed one by one, but the stub's chaos mode must hit "both copies at once" and ACC-14 needs copy A and copy B | Two services `api-a` and `api-b` with the same image and config, differing only in `API_INSTANCE_ID`. |
| D-3 | **Assignment contradicts itself.** Scenario "Shop 4" says a shop may cancel "until it is shipped". Invariant 5 and ACC-7 say that when a cancel races packing, the outcome is "packed and the cancel refused" | Invariant 5 is the stricter, tested rule, so it wins. `packed` and `shipped` orders cannot be cancelled. Allowed from `received, awaiting_stock, reserved, in_wave, picking, picked`. Recorded in README decisions. |
| D-4 | CLAUDE.md repo layout has no package for server-side code shared by api and worker. Reserve, re-reserve, wave formation, the outbox and scheduled actions run in both processes | Added `packages/db` (Prisma schema, SQL migrations, seed, client factory, ledger SQL) and `packages/core` (transactional use-cases written as functions `createX(deps)`, no Nest). `packages/shared` stays IO-free as CLAUDE.md requires. |
| D-5 | CLAUDE.md lists "holidays" in shipping-day calculation. The assignment only says "working days" | Superset: a warehouse has working weekdays plus an optional list of holiday dates (default empty). No assignment rule changes. |
| D-6 | CLAUDE.md's suggested commit 5 ("redis infra, rate limiter") comes before commit 6 ("api core"), but a rate limiter needs a Nest app to guard | B5 ships the limiter as a framework-free function plus its Nest guard, tested against real Redis with a minimal Nest test app. B6 wires it to the real routes. |

---

## 3. Assumptions and decisions (all copied into README "Decisions")

| ID | Gap / ambiguity | Decision |
|---|---|---|
| A-1 | Languages | **English everywhere**: code, comments, plan, docs, README, UI, seed data, error messages, commit messages, the shop stub page. Russian appears only in `ASSIGNMENT.md` (user instruction). `scripts/check-no-cyrillic.ts` runs in CI lint and fails on any Cyrillic character outside `ASSIGNMENT.md`. |
| A-2 | Tooling defaults (assignment silent) | Node 22 LTS in images (Node 24 works locally), pnpm 12 workspaces (the installed version), dependency majors pinned to mature lines (TypeScript 5.9, ESLint 9, Vitest 3, Prisma 6, NestJS 11, zod 3.25, Next 15, BullMQ 5), TypeScript strict, ESLint flat config + typescript-eslint + `eslint-plugin-boundaries` (FSD), Prettier, docker compose v2. |
| A-3 | OpenAPI from zod | `nestjs-zod` builds DTO classes from shared zod schemas. `scripts/openapi-export.ts` boots the app without listening and writes `apps/api/openapi.json`. **Orval** generates the TanStack Query client into `apps/web/src/shared/api/generated`. CI regenerates both and runs `git diff --exit-code`. |
| A-4 | "Nearest to the address" | The order address carries optional `lat/lon`. Distance: haversine if present. Otherwise 0 when the address country matches the warehouse country, else 1. Final tie-break: warehouse id. Pure function in shared. |
| A-5 | Partial reserve: on which warehouse? | When no warehouse covers everything, pick the one covering the **most units**, then nearest, then id. The order is then bound to that warehouse. Re-reserve only happens there. |
| A-6 | When does received stock become reservable | Stock on the receiving dock is not on a shelf and cannot be picked. Re-reserve runs whenever reservable stock grows at a warehouse: putaway, return-cell putaway, an upward adjustment, a released reserve, a lifted cell block. ACC-5 and E2E-3 do receipt + putaway. Shop stock shows a separate `receiving` column (on dock, not yet placed). |
| A-7 | What "reserve expiry" means | (a) The partial reserve of an `awaiting_stock` order expires after `PARTIAL_RESERVE_TTL_MIN` (default 48 h). It is released, and from then on the order is reserved only all-or-nothing, to avoid ping-pong. (b) Nightly: reserves on batches whose remaining shelf life at the projected ship day fell below the shop minimum are moved to a valid batch, or the order goes to `awaiting_stock`. Both run as due-at rows in Postgres. |
| A-8 | Nightly jobs | Per warehouse at `NIGHTLY_LOCAL_TIME` (02:00 local): shelf-life revalidation of reserves (A-7b); ledger reconciliation (balances vs ledger, mismatch → failed-job record, visible to admin); refresh the `daily_order_stats` rollup used by the report; purge idempotency keys older than 7 days. |
| A-9 | Wave content and size | A wave takes ready (`reserved`) orders at one warehouse, sorted by (target cutoff asc, express first, received_at asc), up to `WAVE_MAX_ORDERS` (default 200). The 50-order trigger counts `reserved` orders not in a wave. The timer runs every `WAVE_INTERVAL_MIN` from the last wave, per warehouse. A manual wave resets the timer. One wave formation per warehouse at a time (advisory lock), one wave per order (unique). |
| A-10 | Pick task granularity | One pick task per order (picker fills one tote per order). Lines are sorted by cell walk order. A shortage can add lines in other cells to the same task, re-sorted by route. "Take next" gives the highest-priority unassigned task in the picker's warehouse (`FOR UPDATE SKIP LOCKED`). |
| A-11 | Statuses `in_wave → picking → picked` | `picking` when a picker takes the task. `picked` atomically on the last line's scan. "Hand over to packing" is a UI step with no status. `packed` on the packer's order scan (label generated). `shipped` when a storekeeper or shift lead hands over to the carrier (single order or "ship all packed for today"). |
| A-12 | Roles | Staff: `admin` (global), `shift_lead`, `storekeeper`, `picker`, `packer`, assigned per warehouse (one person can hold several roles at several warehouses). Shop side: `shop_user` (cabinet login) and the shop API key (machine). Packing is also allowed to `shift_lead`. |
| A-13 | Who cancels | Shop (cabinet or API key), admin. Picking stops at once: further scans on a cancelled order's task return `ORDER_CANCELLED`. |
| A-14 | Cancel during picking | Picked qty moves from the order's tote (`PACKING` location) to the warehouse `RETURN` cell (ledger `return`). The unpicked reserve is released. A return-putaway task appears for storekeepers. |
| A-15 | Ship-day boundary | "Before cutoff" means strictly earlier: 16:59:59.999 → today; 17:00:00.000 → next working day. Packing on a non-working day → next working day. Holidays as in D-5. Uses Luxon with IANA tzdata (Kyiv still has DST in tzdata). |
| A-16 | Target cutoff for priority and "at risk" | Target ship day = ship day computed from `received_at` (the earliest day it could ship). An order is "at risk" when it is not packed and `cutoff(target day) − now < AT_RISK_THRESHOLD_MIN` (default 60 min), or the cutoff has already passed. Express and standard share the carrier cutoff. Express only raises priority. |
| A-17 | Stock count flow | A shift lead creates a count for cells (assignee: storekeeper). A shortage auto-creates an unassigned count. Opening a count blocks the cell (`cells.blocked_reason`) and moves its reserves like a shortage. Counted qty per (sku, batch); system qty is read under the cell lock at submit. \|diff\| > 5 **or** \|diff\| / system > 10% → `pending_approval` (system = 0 with any found qty counts as > 10%). Exactly 5 or exactly 10% → auto-applied. Closing applies the adjustments (ledger `adjustment`) and unblocks the cell. A reason is required on every count line with a discrepancy. The author is the counter; the approver is recorded too. |
| A-18 | Shortage report payload | The picker reports the qty actually found (0…expected). The found qty may be picked, the rest is re-reserved. On-hand is not changed until the count; the cell is just blocked. |
| A-19 | Inbound requests (ASN) | Shops create inbound requests (expected SKU lines) by API or cabinet. Receiving is against an ASN or ad hoc. Closing a receipt writes discrepancy rows (over, under, unexpected) visible to the shop. |
| A-20 | Batches | Every SKU has batches. Non-tracked SKUs use one implicit batch (`code = '-'`, no expiry), so keys stay uniform. Tracked SKUs require batch code + expiry date at receipt; expiry in the past is rejected. |
| A-21 | Ledger model | Double entry: one row per location touched, with `on_hand_delta` and `reserved_delta`, plus `from_location_id`, `to_location_id`, `kind`, `doc_type`, `doc_id`, `actor_id`, `created_at`, `group_id`. Virtual locations per warehouse: `RECEIVING`, `PACKING`, `RETURN`, `TRANSIT` (per transfer). Ship and outbound adjustment have `to = NULL`. |
| A-22 | Rate limiter | Fixed window, atomic Lua (`INCR` + `PEXPIRE` on first hit), keys `rl:{bucket}:{subject}:{windowStart}` with a TTL. Buckets: login per IP and per email; shop API per key and per IP; general per IP; scans per staff; socket messages per socket (in-process). Real IP: `X-Real-IP` set by nginx from `$remote_addr`, trusted only when the TCP peer is in `TRUSTED_PROXY_CIDRS`. IPv4-mapped → IPv4; IPv6 → /64. **Redis unavailable:** fail-open to a per-process in-memory limiter with the same limits (degraded, per copy). Correctness never depends on the limiter: Postgres guards hold. |
| A-23 | Auth tokens | Argon2id passwords. JWT access token (15 min) in memory. Rotating refresh token in an httpOnly, SameSite=Strict cookie scoped to `/api/auth`. Refresh families with reuse detection (reuse revokes the family). Logout revokes. Deactivating staff or removing a role takes effect on the next request (role and active flag are checked from the DB, cached ≤ 0, no stale claims). |
| A-24 | Shop API keys | `fk_<prefix8>_<secret32>`. Stored as HMAC-SHA256(pepper, key); lookup by prefix, constant-time compare. Shown once, revocable, many per shop. Seeded demo keys are derived deterministically from `SEED_API_KEY_SALT`, so the README can list them for the `.env.example` value. |
| A-25 | Webhook secrets and signature | Per-shop secret, stored AES-256-GCM-encrypted with `WEBHOOK_SECRET_ENC_KEY`. Header `X-Fulfillment-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + rawBody)>`. The stub rejects a skew > 300 s and replayed event ids. No redirects, `WEBHOOK_TIMEOUT_MS`. |
| A-26 | Webhook ordering and coalescing | Order events: one stream per order, a version per order (status-history sequence), delivered strictly in order, one in flight per stream. Stock events: one stream per (shop, sku). A version from a per-stream counter. A change marks the stream dirty with `due_at = max(now, last_sent_at + 5 s)`. At due time, the payload is built from **current** DB stock (latest value). A newer stock event supersedes a failing older one (the older is marked `superseded`, never sent after a newer one). Exponential backoff, `WEBHOOK_MAX_ATTEMPTS`, then `dead` → admin failed jobs. |
| A-27 | Order import via BullMQ | `POST /shop/v1/orders` (single) validates and inserts synchronously under `UNIQUE(shop_id, external_number)` + payload hash. Same hash → 200 with the existing order. Different hash → 409 `ORDER_CONFLICT`. Reservation is queued. `POST /shop/v1/orders/batch` (≤ 500) creates an `import_batch` processed by the worker's import queue with per-item results at `GET /shop/v1/imports/:id`. |
| A-28 | Scheduled work survives Redis loss | Every pending action is a row in `scheduled_actions(kind, key, due_at, status, lease_until, attempts, last_error)` with a unique `(kind, key)`. A reconciler in each worker (every `RECONCILE_INTERVAL_MS`, and at startup) enqueues due rows into BullMQ with a deterministic `jobId`. A handler claims its row with a conditional `UPDATE … RETURNING` and a lease, and does its effect and the completion in **one transaction**. BullMQ delays are not used for business time, so the test clock works. |
| A-29 | Shared test clock | `TEST_CLOCK_ENABLED=false` by default. When on, `clock.now()` = real now + offset from table `test_clock`, cached and refreshed through Postgres `LISTEN/NOTIFY`. `POST /test/clock` exists only when enabled and requires `TEST_CONTROL_TOKEN`. The e2e compose override enables it. |
| A-30 | UI locale | One locale (English), no i18n framework. Dates shown in the warehouse's time zone, with the zone named. |
| A-31 | Sound on bad scan | Web Audio API oscillator beep (no asset). The message is shown in an `aria-live="assertive"` region. |
| A-32 | Realtime rooms | Rooms are joined only on the server, based on the token: `shop:{id}`, `wh:{id}:lead`, `wh:{id}:floor`, `picker:{staffId}`. A client may ask to subscribe to a warehouse; the server checks the role first. The worker emits through `@socket.io/redis-emitter`. After a reconnect the client refetches from REST (TanStack Query invalidation). Presence: Redis key with a TTL refreshed by heartbeat. |
| A-33 | nginx and Socket.IO | Round-robin upstream over api-a and api-b. The client uses the `websocket` transport only, so no sticky sessions are needed. nginx overwrites `X-Real-IP`/`X-Forwarded-For` with `$remote_addr`. Body limit 1 MB → 413. |
| A-34 | Shop stub tech | Fastify + server-rendered HTML (functional, small). Received webhooks are kept in memory (restart clears the page). Chaos is set by `SHOP_STUB_CHAOS` in `.env`. A test-only control endpoint (`SHOP_STUB_CONTROL_ENABLED`) changes the pattern at runtime. Chaos randomness uses a seeded PRNG (`SHOP_STUB_CHAOS_SEED`). "Every fifth" is deterministic (5th, 10th…, alternating 500 and timeout). |
| A-35 | Seed profiles (user instruction: tests use small data; big data only where a limit is being checked) | One set-based SQL seed, scaled by `SEED_PROFILE`. **`small`** (200 SKUs, 100 cells/wh, 5 k movements, 1 k orders, 30 in progress): used by **every** test run: unit, integration, adversarial, e2e, the CI jobs and local `pnpm test`. Tests that need specific data (300 orders on one SKU, 10/40/90-day batches, 50 waiting orders…) build their own small fixtures through factories (`test/fixtures/*.ts`), not from seed rows. **`full`** (the assignment's numbers): the default for `docker compose up` (the deliverable), and used in tests **only** by the jobs that check size or speed limits: `pnpm test:perf` (NFR-1..3, ACC-16) and `seed-full-check.sql` (SEED-3..6 counts). These run in a separate CI job, `perf-full-seed`, and locally on demand. They are never part of the default test command. Balances are derived from the ledger. A `seed_runs` marker makes the seed idempotent. |
| A-36 | Seeded credentials | Staff `admin@demo.local`, `lead.kyiv@…`, `lead.warsaw@…`, `store.kyiv@…`, `picker1.kyiv@…`, `picker2.kyiv@…`, `packer.kyiv@…` (and the same for Warsaw), and shop users `shop1…shop5@demo.local`. All use `SEED_DEMO_PASSWORD`. API keys derived per A-24. All are listed in the README. |
| A-37 | Labels | PDFKit A6 label with Code128 (bwip-js): order no., shop, address, delivery method, warehouse, ship day. Text is sanitised. `Content-Disposition` file name is built from the order id only. A shop may download only its own labels. |
| A-38 | Performance strategy | Stock: `stock_balances` covering index `(sku_id, warehouse_id)` plus a per-(warehouse, sku, batch) summary maintained in the same transaction. Search: btree on `(shop_id, external_number)`, `pg_trgm` GIN on customer name, and `order_lines(sku_id)` + SKU barcode/code index. Report: `daily_order_stats` rollup for closed days + a live query for today, `percentile_cont` on an indexed `shipped_at` range. Measured through nginx on the full seed. |
| A-39 | Workers in compose | `worker` with `deploy.replicas: ${WORKER_REPLICAS:-3}`, so ACC-3 holds on the stock compose too. The adversarial harness starts its own 3 worker child processes for `kill -9`. |
| A-40 | Input limits | Order: 1–500 lines, qty integer 1…100 000, duplicate SKU lines rejected (`DUPLICATE_LINE`), strings ≤ 500 chars, NFC-normalised. JSON depth ≤ 20, `__proto__`/`constructor` keys rejected. Unknown fields rejected (zod `.strict()`, which blocks mass assignment). Pagination: `limit` 1…200, cursor-based. |
| A-41 | Error format | `{ error: { code: string, message: string, fields?: [{ path, code, message }], requestId } }`. One global exception filter maps zod, domain `Result` errors, Prisma known errors and everything else to it. Unknown errors → 500 with `code: "UNEXPECTED"` and no internals; a test asserts no endpoint ever reaches it with fuzzed input. |
| A-42 | Distance between warehouses for transfers | Not modelled. A transfer leaves stock in `TRANSIT` until the destination receives it. |
| A-43 | Host ports | Other local projects use 8080/5433/6380, so compose publishes nginx on 28080, postgres on 25432, redis on 26379 and the stub on 24000 (all in `.env`). Compose network 172.31.116.0/24 with nginx pinned at .10. |
| A-44 | Test databases | Each package's integration tests use their own database (`fulfillment_<pkg>_test`) and Redis db index, dropped and migrated at start, so packages never interfere. |
| A-45 | "On time" in the report | An order is on time when it was packed before the cutoff of its target ship day (the earliest day it could ship, from `received_at`), i.e. it left on its earliest possible ship day. |

---

## 3.A Order status transitions (goes to README, generated from `packages/shared`)

| From | To | Who | When |
|---|---|---|---|
| — | `received` | shop (API key / cabinet), import job | order accepted |
| `received` | `reserved` | system (reservation job) | all lines reserved at one warehouse |
| `received` | `awaiting_stock` | system | partial or no reserve |
| `awaiting_stock` | `reserved` | system (re-reserve) | missing qty reserved |
| `reserved` | `awaiting_stock` | system | count or shortage moved reserve away and none left; nightly shelf-life revalidation |
| `reserved` | `in_wave` | system (wave timer / 50 ready), shift lead (manual wave) | wave formed |
| `in_wave` | `awaiting_stock` | system | count or shortage, no alternative stock |
| `in_wave` | `picking` | picker (takes task), shift lead (reassign keeps `picking`) | task taken |
| `picking` | `picked` | picker | last line scanned |
| `picking` | `awaiting_stock` | system | shortage with no alternative stock |
| `picked` | `packed` | packer, shift lead | order scanned at packing, label made |
| `packed` | `shipped` | storekeeper, shift lead | handed to carrier |
| `received`…`picked` | `cancelled` | shop, admin | see RUL-8 / D-3 |
| `packed`, `shipped`, `cancelled` | `cancelled` | — | refused (`INVALID_TRANSITION`, or 200 no-op for an already cancelled order) |

---

## 4. Architecture

### 4.1 Stack

| Part | Choice | Source |
|---|---|---|
| DB | PostgreSQL 16, Prisma 6 (schema + client), raw SQL migrations for CHECK, partial unique, triggers, `pg_trgm` | ASSIGNMENT |
| Queue / pubsub | Redis 7, BullMQ 5, `@socket.io/redis-adapter`, `@socket.io/redis-emitter` | ASSIGNMENT |
| API | NestJS 11, `@nestjs/swagger`, `nestjs-zod`, `@nestjs/websockets` + Socket.IO 4, Express HTTP adapter (the one nestjs-zod and swagger support best) | ASSIGNMENT + A-2 |
| Worker | NestJS 11 standalone application context + BullMQ processors | ASSIGNMENT |
| Web | Next.js 15 App Router, React 19, TanStack Query 5, React Hook Form + zod resolver, Tailwind 4, Orval client, socket.io-client | ASSIGNMENT |
| Shared | zod, Luxon | ASSIGNMENT + A-15 |
| Shop stub | Fastify 5 | A-34 |
| Proxy | nginx 1.27 | CLAUDE.md default (assignment lists nginx) |
| Tests | Vitest 3 (+ `unplugin-swc` for Nest), Playwright | ASSIGNMENT |
| PDF | PDFKit + bwip-js | A-37 |
| Monorepo | pnpm 9 workspaces, Node 22 | A-2 |

### 4.2 Folder tree

```
.
├── .github/workflows/ci.yml          CI: install, typecheck, lint, openapi+client diff, unit, integration, build, e2e/adversarial/perf
├── apps/
│   ├── api/                          NestJS HTTP + Socket.IO
│   │   ├── src/
│   │   │   ├── config/env.ts         zod env, the only process.env reader
│   │   │   ├── main.ts, app.module.ts
│   │   │   ├── common/               error filter, zod pipe, auth guards, roles, rate-limit guard, client-ip, request-id
│   │   │   ├── infra/                prisma, redis, queues, socket adapter, clock, pdf, crypto
│   │   │   └── modules/<domain>/     auth, staff, shops, api-keys, warehouses, cells, skus, orders, inbound,
│   │   │                             receiving, putaway, moves, transfers, stock, waves, picking, packing,
│   │   │                             shipping, stock-counts, reports, webhooks-admin, jobs-admin, realtime,
│   │   │                             time, test-clock   (each: module/controller/service thin, domain/, dto/, repo/, *.spec.ts)
│   │   ├── test/
│   │   │   ├── integration/          *.int.spec.ts against real pg+redis
│   │   │   └── attacker/             adversarial harness (client, apiCopy, socket, burst, flood, raw, shop, worker, redis, ledger, clock, timed) + *.adv.spec.ts
│   │   ├── scripts/openapi-export.ts
│   │   └── openapi.json              committed, CI-diffed
│   ├── worker/                       NestJS standalone + BullMQ processors
│   │   └── src/{config,infra,processors/<queue>,reconciler}/
│   ├── web/                          Next.js
│   │   ├── app/                      Next route files only, thin re-exports of src/pages
│   │   ├── pages/README.md           keeps Next off src/pages
│   │   └── src/{app,pages,widgets,features,entities,shared}/   FSD layers
│   └── shop-stub/                    Fastify demo shop
│       └── src/{config,send,webhooks,chaos,ui}/
├── packages/
│   ├── shared/                       zod schemas, rules, pure calcs (no IO): shipping-day, fefo, warehouse-select,
│   │                                 rereserve-priority, wave, count-threshold, status, webhook-coalesce, putaway, route, errors, result
│   ├── db/                           prisma/schema.prisma, prisma/migrations (SQL), seed (SQL + runner), client factory, ledger SQL
│   └── core/                         transactional use-cases shared by api & worker: reserve, rereserve, waves,
│                                     relocate-reserve, outbox, scheduled-actions, realtime-events (functions, injected deps)
├── infra/
│   ├── nginx/nginx.conf              upstream api-a/api-b, /api, /socket.io, /docs, / → web, real-IP headers, 413
│   ├── db/init.sql                   extensions (pg_trgm)
│   └── redis/redis.conf              no persistence (Redis is disposable), maxmemory policy noeviction for BullMQ
├── e2e/                              Playwright specs + docker-compose.e2e.yml override
├── scripts/                          compose-smoke.sh, verify-history.sh, mutation-check.sh, acceptance.ts, readme-check.ts, gen-status-table.ts, perf.ts
├── docs/                             BUGS_FOUND.md, SECURITY-TESTS.md, MUTATION-CHECK.md
├── docker-compose.yml, .env.example, README.md, plan.md, CLAUDE.md, ASSIGNMENT.md
```

### 4.3 Data flow

```
 shop stub ──HTTP (API key)──► nginx ──► api-a / api-b ──tx──► Postgres (truth: orders, ledger, balances,
     ▲          (chaos: direct to api-a AND api-b)  │               scheduled_actions, webhook outbox, waves)
     │                                              │ enqueue (jobId = kind:key:due)        ▲
     │ webhooks (HMAC)                              ▼                                       │ claim row + effect + done in one tx
     └──────────────────────────────── worker ×3 ◄── Redis (BullMQ copies, adapter, presence, rate limits)
                                         │  reconciler: scheduled_actions due ⇒ BullMQ (rebuilds after FLUSHALL)
                                         └─ redis-emitter ──► Socket.IO rooms ──► api-a/api-b ──► web (lead dashboard, shop stock, picker)
 web (browser) ──► nginx: / → web (Next), /api + /socket.io → api upstream (websocket only), /docs → swagger
```

Writes always commit to Postgres first. Each one inserts or updates a `scheduled_actions` row or a `webhook_events` outbox row in the same transaction. Redis only accelerates work: the reconciler rebuilds it from Postgres. Realtime events are emitted after commit (best effort). After a reconnect, clients refetch from REST.

---

## 5. Env table

`.env.example` holds every variable. Sensitive variables have no default and fail startup when missing. "Used by": A=api, W=worker, Wb=web, S=shop-stub, M=migrate/seed, C=compose, N=nginx (templated), T=tests.

| Name | Purpose | Sensitive | Default | Used by |
|---|---|---|---|---|
| NODE_ENV | runtime mode | no | `production` | A W Wb S M |
| LOG_LEVEL | pino level | no | `info` | A W S |
| POSTGRES_USER | db user (compose) | no | `fulfillment` | C |
| POSTGRES_PASSWORD | db password | **yes** | — | C |
| POSTGRES_DB | db name | no | `fulfillment` | C |
| DATABASE_URL | Prisma / pg connection | **yes** (has password) | — | A W M T |
| REDIS_URL | Redis connection | **yes** (may carry auth) | — | A W T |
| API_PORT | api listen port | no | `3000` | A C |
| API_INSTANCE_ID | copy label (`a`/`b`) for logs and tests | no | `local` | A |
| JWT_ACCESS_SECRET | access token HMAC | **yes** | — | A |
| JWT_REFRESH_SECRET | refresh token HMAC | **yes** | — | A |
| JWT_ACCESS_TTL_SEC | access TTL | no | `900` | A |
| JWT_REFRESH_TTL_SEC | refresh TTL | no | `1209600` | A |
| API_KEY_PEPPER | API key hashing pepper | **yes** | — | A M |
| WEBHOOK_SECRET_ENC_KEY | AES-GCM key (base64, 32 B) for per-shop webhook secrets | **yes** | — | A W M |
| CORS_ORIGINS | comma-separated allowlist | no | `http://localhost:8080` | A |
| TRUSTED_PROXY_CIDRS | peers allowed to set client IP headers | no | `` (trust none) | A |
| BODY_LIMIT_BYTES | max request body | no | `1048576` | A N |
| RATE_LIMIT_ENABLED | master switch | no | `true` | A |
| RATE_LIMIT_WINDOW_MS | window | no | `60000` | A |
| RATE_LIMIT_LOGIN_PER_IP | login attempts / IP / window | no | `20` | A |
| RATE_LIMIT_LOGIN_PER_ACCOUNT | login attempts / email / window | no | `10` | A |
| RATE_LIMIT_GENERAL_PER_IP | any request / IP / window | no | `6000` | A |
| RATE_LIMIT_SHOP_API_PER_KEY | shop API / key / window | no | `3000` | A |
| RATE_LIMIT_SHOP_API_PER_IP | shop API / IP / window | no | `3000` | A |
| RATE_LIMIT_SCAN_PER_STAFF | scans / staff / window | no | `600` | A |
| RATE_LIMIT_SOCKET_MSG_PER_SEC | socket messages / socket / s | no | `20` | A |
| SOCKET_PRESENCE_TTL_SEC | presence expiry | no | `30` | A |
| AT_RISK_THRESHOLD_MIN | at-risk window before cutoff | no | `60` | A W |
| TEST_CLOCK_ENABLED | enable shared test clock + endpoint | no | `false` | A W |
| TEST_CONTROL_TOKEN | auth for test-only endpoints (required iff enabled) | **yes** | — | A S T |
| WORKER_CONCURRENCY | BullMQ concurrency per queue | no | `5` | W |
| WORKER_REPLICAS | compose worker copies | no | `3` | C |
| RECONCILE_INTERVAL_MS | reconciler tick | no | `1000` | W |
| JOB_LEASE_MS | claim lease | no | `30000` | W |
| JOB_MAX_ATTEMPTS | attempts before `dead` | no | `5` | W |
| JOB_BACKOFF_MS | base backoff | no | `1000` | W |
| WAVE_INTERVAL_MIN | wave timer | no | `15` | W A |
| WAVE_READY_THRESHOLD | instant wave trigger | no | `50` | W A |
| WAVE_MAX_ORDERS | wave cap | no | `200` | W A |
| PARTIAL_RESERVE_TTL_MIN | partial reserve expiry | no | `2880` | W |
| NIGHTLY_LOCAL_TIME | nightly jobs local time | no | `02:00` | W |
| WEBHOOK_COALESCE_MS | per-SKU stock window | no | `5000` | W |
| WEBHOOK_TIMEOUT_MS | outbound timeout | no | `5000` | W |
| WEBHOOK_MAX_ATTEMPTS | delivery attempts | no | `10` | W |
| WEBHOOK_BACKOFF_BASE_MS | backoff base | no | `1000` | W |
| WEBHOOK_BACKOFF_MAX_MS | backoff cap | no | `60000` | W |
| WEBHOOK_ALLOW_PRIVATE_HOSTS | allow private-network webhook URLs (the stub lives in the docker net) | no | `false` | A W |
| SEED_PROFILE | `small` \| `full` (A-35) | no | `small` in code; `.env.example` sets `full` for `docker compose up`; every test script and CI test job forces `small`, except `perf-full-seed` | M T |
| SEED_DEMO_PASSWORD | password of all seeded users | **yes** | — | M T |
| SEED_API_KEY_SALT | derives seeded shop API keys | **yes** | — | M S T |
| SEED_WEBHOOK_SECRET_SALT | derives seeded shop webhook secrets | **yes** | — | M S |
| WEB_PORT | Next port | no | `3001` | Wb C |
| API_INTERNAL_URL | server-side API base for Next (server-only) | no | `http://nginx/api` | Wb |
| NEXT_PUBLIC_API_BASE_URL | browser API base | no | `/api` | Wb |
| NEXT_PUBLIC_SOCKET_PATH | browser socket path | no | `/socket.io` | Wb |
| NGINX_HOST_PORT | published port | no | `8080` | C |
| SHOP_STUB_PORT | stub port (also published) | no | `4000` | S C |
| SHOP_STUB_API_URL | via nginx | no | `http://nginx/api` | S |
| SHOP_STUB_API_A_URL | direct copy A (chaos) | no | `http://api-a:3000` | S |
| SHOP_STUB_API_B_URL | direct copy B (chaos) | no | `http://api-b:3000` | S |
| SHOP_STUB_CHAOS | chaos mode switch | no | `false` | S |
| SHOP_STUB_CHAOS_CANCEL_RATE | chance of an instant cancel | no | `0.1` | S |
| SHOP_STUB_CHAOS_SEED | PRNG seed | no | `42` | S |
| SHOP_STUB_CONTROL_ENABLED | test control endpoint | no | `false` | S |
| SHOP_STUB_WEBHOOK_MAX_SKEW_SEC | signature timestamp tolerance | no | `300` | S |
| E2E_BASE_URL | Playwright target | no | `http://localhost:8080` | T |

Compose pins `TRUSTED_PROXY_CIDRS` to nginx's fixed IP on the compose network (`172.28.0.10/32`, set in `.env.example`).

---

## 6. Threat model

**Assets:** stock correctness (ledger, balances, reserves), order state, shop data isolation, staff accounts, shop API keys, webhook secrets, availability for honest shops and floor staff.

**Attackers:** (1) an anonymous internet client; (2) a malicious or buggy shop with a valid API key or cabinet login; (3) an insider employee with a low role (picker, storekeeper) or on another warehouse; (4) a network-level replayer or tamperer of webhooks; (5) "accidental attackers": a double-clicking picker, a retrying shop, chaos mode, crashing workers, Redis loss.

| # | Area | Abuse case | Mitigation | Test |
|---|---|---|---|---|
| T-1 | Auth | Login brute force, user enumeration via body, status or timing | per-IP and per-account limits; identical error and dummy argon2 verify on unknown user | `A: auth.adv.spec.ts` |
| T-2 | Auth | Token tampering, `alg:none`, wrong secret, expired, nbf, missing claims, another user's token | jose verify with a fixed alg, required claims | same |
| T-3 | Auth | Refresh reuse after rotation, replay after logout, parallel refresh | family revocation; one-time refresh rows with a conditional update | same |
| T-4 | Auth | Deactivated staff or removed role keeps access | roles loaded from DB per request | same |
| T-5 | API keys | Shop A key on shop B data; revoked key; truncated, guessed or malformed key; key in logs | scope by key → shop only; hashed + pepper; constant time; log redaction | `A: api-keys.adv.spec.ts` + log scan assert |
| T-6 | Routes | Missing guard on any route | route table iteration: 401 without creds, 403 with wrong principal/role | `A: route-guard-matrix.adv.spec.ts` |
| T-7 | Routes | IDOR: other shop's order, SKU, stock, label; other warehouse; other picker's task | every repo query takes the principal's scope; tests per resource | `A: acceptance-15.adv.spec.ts`, `A: authz.adv.spec.ts` |
| T-8 | Routes | Role escalation (picker approves adjustment, storekeeper starts wave), mass assignment (`shopId`, `status`, `reserved`, `version`, `approvedBy`) | role guard; zod `.strict()` | `A: authz.adv.spec.ts` |
| T-9 | Rate limit | Flood from one IP locks out others; spoofed XFF evades or frames a victim; parallel requests exceed the limit; per-copy only limits | Redis Lua, real IP from trusted proxy only, shared buckets | `A: rate-limit.adv.spec.ts` |
| T-10 | Rate limit | Limiter blocks legit acceptance traffic | defaults sized for the acceptance runs | `A: rate-limit-acceptance.adv.spec.ts` |
| T-11 | Sockets | Unauthenticated connect; joining another shop's or warehouse's room; internal data leak to shop sockets; message flood | handshake auth; server-side rooms; event payload projection per audience; per-socket throttle | `A: socket-authz.adv.spec.ts` |
| T-12 | Webhooks | Tampered body, wrong secret, stale timestamp, replay at the stub | HMAC over `t.body`, skew window, event id dedup | `U: shop-stub/verify.spec.ts` |
| T-13 | Webhooks | SSRF via webhook URL (metadata IPs, localhost), redirects, header injection, slow receiver blocks others | URL validation + resolved-IP denylist unless `WEBHOOK_ALLOW_PRIVATE_HOSTS`; no redirects; timeout; per-shop concurrency | `A: webhooks-ssrf.adv.spec.ts` |
| T-14 | Input | SQLi in search and report filters, LIKE wildcards, injected sort column, XSS in names, addresses and reasons (web, stub page, PDF), CRLF in file names, null bytes, unicode tricks, deep JSON, prototype pollution, wrong content type, duplicate keys, huge arrays, 413 | parameterised SQL; sort allowlist; escape LIKE; React escaping + stub HTML escaping; zod limits; body limit | `A: input-fuzz.adv.spec.ts` |
| T-15 | Input | Domain values: invalid tz, `25:00`, no working days, past expiry, int overflow, capacity ≤ 0, inverted or oversized report period, negative pagination | shared zod schemas | `I:` + `A: input-fuzz.adv.spec.ts` |
| T-16 | Transport | Slowloris, many connections, keep-alive floods | nginx timeouts and `limit_conn`; Node `headersTimeout`/`requestTimeout` | `A: exhaustion.adv.spec.ts` |
| T-17 | Transport | CORS from a disallowed origin; missing security headers | allowlist; helmet | `A: headers.adv.spec.ts` |
| T-18 | Test hooks | Test-clock or stub-control endpoint reachable in prod | not mounted unless env-enabled + token | `A: test-clock.adv.spec.ts` |
| T-19 | Inbound orders | `shopId` in body, another shop's SKU barcode, cancel for another shop's order, cancel right after the order, cancel after shipping, malformed orders (unknown SKU, 0 or negative or fractional qty, duplicate lines, 10 000 lines, missing address, unknown method) | shop from key only; SKU lookup scoped to the shop; strict schema | `A: inbound-orders.adv.spec.ts` |
| **Races (from the invariants)** |
| R-1 | Reserve | 300 parallel orders on 100 units (INV-2) | balance rows locked `FOR UPDATE` in (warehouse, sku, batch, cell) order; CHECK `reserved ≤ on_hand`; deadlock / serialization retry ≤ 5 | ACC-3 |
| R-2 | Re-reserve | Two receipts at once; cancel racing re-reserve; one order getting stock twice (INV-3) | per-(warehouse, sku) advisory xact lock; order row lock; line `reserved_qty ≤ qty` CHECK | ACC-5 |
| R-3 | Scan | Two pickers on one line; replayed scan (INV-4) | unique `idempotency_key`; conditional `UPDATE … SET picked = picked + 1 WHERE picked < qty`; task ownership check in the same statement | ACC-6 |
| R-4 | Cancel | Cancel vs last scan, cancel vs pack (INV-5) | order row `FOR UPDATE` in all three paths; conditional status update; return movement in the same tx | ACC-7 |
| R-5 | Shortage | Shortage vs a second picker on the same cell (INV-6) | cell row `FOR UPDATE`; scans check `cells.blocked_reason IS NULL` under the same lock | `A: race-shortage.adv.spec.ts` |
| R-6 | Count | Count start vs in-flight scan (INV-7) | same cell lock; partial unique one-open-count-per-cell | ACC-9 |
| R-7 | Import | 10 duplicates across both copies (INV-8) | `UNIQUE(shop_id, external_number)` + `INSERT … ON CONFLICT DO NOTHING RETURNING`, hash compare | ACC-11 |
| R-8 | Waves | Manual wave vs timer wave; two workers forming waves | advisory lock per warehouse; `UNIQUE(order_id)` in wave_orders; status condition | `A: race-wave.adv.spec.ts` |
| R-9 | Tasks | Reassign vs picker scanning | task row lock; scan checks `assignee = me` atomically | `A: race-reassign.adv.spec.ts` |
| R-10 | Moves | A→B vs B→A | lock cells in id order; retry on deadlock → never a raw 500 | `A: race-moves.adv.spec.ts` |
| R-11 | Jobs | kill -9 mid-job; same job on 3 workers; FLUSHALL (INV-10, 11) | claim with lease; effect + done in one tx; reconciler rebuild | ACC-12, `A: jobs.adv.spec.ts` |
| R-12 | Webhooks | Out-of-order versions; double delivery after a retry (INV-9) | one in-flight per stream (row lock); supersede; monotonic per-stream counter | ACC-11, `A: webhooks.adv.spec.ts` |
| R-13 | Uniques | Parallel creation with the same unique key (SKU barcode per shop, cell code per warehouse, staff email, order no.); double-submit of receipts, adjustments, cancels | DB uniques; idempotency keys on POSTs from floor screens | `A: race-uniques.adv.spec.ts` |

---

## 7. Test plan

**Unit (`packages/shared`, `apps/*/domain`, web `model/lib`):** shipping day (Kyiv and Warsaw, spring and autumn DST nights, cutoff ±1 ms, Friday 17:01, weekend and holiday packing, a cutoff falling inside the skipped DST hour e.g. 02:30 → documented rule: the next valid local instant); FEFO (equal expiries → oldest receipt, then batch id; min shelf life exactly, −1 day, +1 day; non-tracked SKU); warehouse selection; re-reserve priority; wave trigger (49/50/51, 14:59.999 vs 15:00) and ordering; count thresholds (5 / 6 / 10% / 10.01% / system 0); full status matrix (9×9×actor); webhook coalescing (4.999 vs 5.000 s, supersede); putaway suggestion; route ordering; client IP parsing (XFF chains, IPv6 /64, IPv4-mapped); HMAC sign and verify; error mapping; web: server-time offset, scan input buffer, URL-state codecs, zod → field errors.

**Integration (`apps/api/test/integration`, `apps/worker/test`, `packages/core`, `packages/db`):** a real Postgres 16 and Redis 7 (compose services locally, GitHub services in CI). The schema is migrated once; each test creates its own shops, warehouses and SKUs, so tests can run in parallel. Covers every module's happy path plus its error codes, constraints, ledger rows per operation, queue processors, reconciler rebuild, outbox state machine, OpenAPI completeness (every operation declares the shared error schema), and seed idempotency.

**Adversarial suite (`apps/api/test/attacker`, `pnpm test:adversarial`):** global setup builds the apps and starts real nginx (docker, `--network host`, the same `nginx.conf` template) in front of api-a and api-b child processes on ephemeral ports, 3 worker child processes, and the shop stub, all with `.env.example` values (test clock enabled with a token). The harness is exactly the one the skill describes (`client({sourceIp, auth})` with `localAddress: 127.0.0.N`, `apiCopy`, `socket`, `burst` with a barrier, `flood`, `slowRequest`, `raw`, `shop`, `worker.start/kill9/restart`, `redis.flushAll/restart`, `ledger.assertBalanced`, `timed`, `clock.advance`). Concrete scenarios:

- ACC-3 / ACC-4 / ACC-5 / ACC-6 / ACC-7 / ACC-8 / ACC-9 / ACC-10 / ACC-11 / ACC-12 / ACC-13 / ACC-14 / ACC-15 (see §1.11). Race tests loop ×N (≥ 20 for scan/cancel, ×5 for the 300-order case).
- FEFO under concurrency where the "40-day" batch runs out partway → the next valid batch (90) is used, "10" is never touched.
- Re-reserve: two receipts in parallel; cancel racing the re-reserve.
- Racing: shortage vs second picker; count vs scan; manual vs timer wave; reassign vs scan; A→B vs B→A moves.
- Transfers: in transit is unavailable at both ends until receipt.
- Jobs: kill -9 mid-reserve and mid-wave; the same job on 3 workers; exhausted job visible to admin and rerun exactly once, 403 for non-admin; downtime catch-up (stop workers, advance the clock past wave slots, cutoff and nightly, start → each fires once, in order).
- Redis: FLUSHALL with live wave timers, re-reserves, webhooks and expiries, and a Redis restart; the limiter fails open as documented.
- Webhooks via chaos (500 / timeout every fifth): every event delivered (counted at the stub), versions monotonic, ≤ 1 stock event per SKU per 5 s with the latest value, staleness ≤ 5 s + retries; SSRF and redirect refusal; a slow receiver does not delay other shops.
- Auth, API keys, route-guard matrix, IDOR, escalation, mass assignment, parallel uniques and double-submits.
- Rate limiter: flood from 127.0.0.2 while 127.0.0.3 and 127.0.0.4 stay 2xx (p95 < 150 ms); spoofed headers; rotating spoof; off-by-one at the limit; window recovery; `Retry-After`; totals across both copies; key TTL; IPv6 / IPv4-mapped; Redis down → fail-open per copy; acceptance flows under default limits.
- Sockets: unauthenticated rejected; foreign rooms refused on both copies; no internal fields on shop events; delivery < 1 s across copies; presence expiry; reconnect catch-up; flood throttled.
- Input fuzz over the route table: SQLi, LIKE wildcards, sort injection, XSS (stored → checked in the web DOM, stub page and PDF text), CRLF, null bytes, unicode, long strings, deep JSON, proto pollution, wrong content types, malformed JSON, duplicate keys, huge arrays, 413, bad pagination, unexpected methods. Assert the shared error format and never `UNEXPECTED`.
- Exhaustion: slowloris and connection floods; others stay responsive. CORS and headers.
- Test-clock and stub-control endpoints → 404 when disabled.

Every concurrency test ends with `ledger.assertBalanced()`. Results go in `docs/SECURITY-TESTS.md`, bugs in `docs/BUGS_FOUND.md`.

**E2E (Playwright on `docker compose -f docker-compose.yml -f e2e/docker-compose.e2e.yml`):** E2E-1…4, scanner keyboard-only, live updates, forms, URL state, admin failed-jobs rerun.

**Test data (A-35):** every suite above runs on the `small` seed plus per-test fixtures. The full seed is loaded only for the performance and seed-size checks below.

**Performance (`pnpm test:perf` → `scripts/perf.ts`, the only suite on `SEED_PROFILE=full`; separate CI job `perf-full-seed`):** p95 over 30 warm requests through nginx for stock by SKU, search by number, customer and SKU, and the 90-day report. Fails above budget.

**Mutation check (`scripts/mutation-check.sh`):** applies patches one at a time: (1) rate-limit guard returns `true`; (2) the role/ownership guard skips its check; (3) the order schema drops `.positive()` on qty; (4) the reserve SQL drops `FOR UPDATE`; (5) the migration drops `UNIQUE(shop_id, external_number)`; (6) the scan drops its idempotency unique. It runs the matching tests, expects failure, then reverts. Output goes in `docs/MUTATION-CHECK.md`.

---

## 8. Commit plan (12 commits; each green on typecheck, lint, test, build and the CI workflow as it stands)

| # | Block | Contents | Proven by |
|---|---|---|---|
| 1 | `chore: scaffold monorepo, env, compose base, CI` | pnpm workspace, tsconfig base, ESLint (paradigm rules: no `class` outside Nest files, no `process.env` outside env.ts, no default exports; FSD boundaries), Prettier, `.env.example` (all vars), `.gitignore`, `docker-compose.yml` with postgres and redis, `infra/db`, `infra/redis`, `packages/shared` skeleton (`Result`, error codes), `.github/workflows/ci.yml` (install, typecheck, lint, unit, build; integration job with services) | CI commands green; `U: result.spec.ts`; `S: lint fixtures` (a bad file fails lint) |
| 2 | `feat(shared): domain rules` | shipping day/cutoff with DST and holidays, FEFO + min shelf life, warehouse selection, re-reserve priority, wave trigger and priority, count thresholds, status transitions + table generator, webhook coalescing/version rules, putaway suggestion, route ordering, zod input schemas, error schema | `U:` full suite (§7) |
| 3 | `feat(db): schema, migrations, ledger, constraints` | `packages/db`: Prisma schema, SQL migration with CHECKs, partial uniques, `pg_trgm`, indexes, ledger tables + `ledger_balance_check()` SQL, client factory, test-db helpers | `I: constraints.int.spec.ts`, `I: ledger-balance-fn.int.spec.ts` |
| 4 | `feat(db): set-based idempotent seed` | small/full profiles, derived credentials, ledger-consistent balances, ~300 in-progress orders with at-risk ones | `I: seed.int.spec.ts` (small; twice; balanced) |
| 5 | `feat(infra): redis, queues, rate limiter, socket adapter, clock` | `packages/core`: clock (real + test clock via LISTEN/NOTIFY), scheduled-actions table API, queue factories with deterministic job ids; api `common/`: client-ip, Lua rate limiter + guard, Socket.IO Redis adapter + emitter, error filter, zod pipe | `U: client-ip`; `I: rate-limiter.int.spec.ts` (atomic, parallel, TTL, fail-open), `I: socket-adapter.int.spec.ts`, `I: clock.int.spec.ts` |
| 6 | `feat(api): core — auth, roles, api keys, warehouses, shops, staff, SKUs, order import, stock, search` | NestJS app, swagger at `/docs`, openapi export + committed `openapi.json`, CI openapi diff step, auth (argon2, JWT + refresh families), guards, API keys, admin CRUD, SKUs, inbound ASN, idempotent order import (single + batch record), stock view, order search, time endpoint, test-clock endpoint | `I:` module tests; `I: openapi.int.spec.ts`; `I: orders-import.int.spec.ts` (10 parallel) |
| 7 | `feat(shop-stub): orders, signed webhooks, chaos` | Fastify stub, page with send buttons (1 / N), HTTP send API, webhook receiver with HMAC verify and versions page, chaos modes, control endpoint, compose service | `U: verify.spec.ts`, `U: chaos.spec.ts`; `I: send.int.spec.ts` |
| 8 | `feat(api): inventory and floor flows` | `packages/core` reserve/re-reserve/relocate; receiving, putaway, moves, transfers, waves (manual), take task, scan, shortage, stock counts + approval, cancel, packing + label PDF, shipping, reports, realtime gateway (rooms, presence, events), dashboard | `I:` per module incl. race tests in-process (reserve 300 in parallel against one api, scan double, cancel vs scan), `assertBalanced` |
| 9 | `feat(worker): reconciler, waves, re-reserve, expiry, nightly, webhook outbox, failed jobs` | Nest worker, processors per queue, reconciler, lease claims, wave timers and 50-trigger, reserve expiry, nightly jobs, webhook delivery (HMAC, backoff, coalescing, supersede, SSRF guard), failed-jobs admin endpoints in api | `I:` processors; `I: reconciler-flushall.int.spec.ts`; `I: webhook-delivery.int.spec.ts` against the stub |
| 10 | `feat(web): cabinet, floor screens, dashboard, admin` | FSD layout, generated Orval client + CI client diff, auth, shop cabinet (SKUs, orders, stock live, ASN), storekeeper (receiving, putaway, moves, transfers), picker scanner, packer, shift dashboard (live, at-risk, waves, reassign, counts approval), report with URL state, admin (warehouses, zones, cells, shops + keys, staff, failed jobs) | `U:` web model/lib + feature flows; FSD lint; `next build` |
| 11 | `test: nginx, full compose, adversarial suite, e2e, perf` | nginx config, api-a/api-b, migrate one-shot, worker ×3, web, stub in compose; e2e override; attacker harness + all `*.adv.spec.ts`; Playwright E2E-1…4 + UI specs; perf script; compose-smoke; CI jobs `adversarial` + `e2e` (small seed) and `perf-full-seed` (full seed, perf + seed-size checks only); `docs/SECURITY-TESTS.md`, `docs/BUGS_FOUND.md`, `docs/MUTATION-CHECK.md`; fixes for every bug found (each with its test) | the whole adversarial suite, E2E, perf, smoke, mutation check |
| 12 | `docs: README` | every assignment section, generated status table, indexes and constraints, decisions (A-*, D-*), credentials; `readme-check` in CI; `scripts/acceptance.ts`; `verify-history.sh` | `R: readme-check`; `pnpm acceptance` table recorded in §10 |

Bugs found in commit 11 by the adversarial suite are fixed inside commit 11, so no later commit is red. If a fix belongs to an earlier block's code, it still lands in commit 11 with its test, logged in `docs/BUGS_FOUND.md`.

---

## 9. Progress checklist

- [x] Phase 0: plan approved
- [x] 1 scaffold + env + compose base + CI
- [x] 2 shared domain rules
- [x] 3 db schema, migrations, ledger, constraints
- [x] 4 seed
- [x] 5 redis infra, queues, rate limiter, socket adapter, clock
- [x] 6 api core
- [x] 7 shop stub
- [x] 8 api inventory and floor flows
- [x] 9 worker
- [ ] 10 web
- [ ] 11 nginx + full compose + adversarial + e2e + perf
- [ ] 12 README
- [ ] Every matrix row passing (§1)
- [ ] ACC-1…17 run and recorded (§10)
- [ ] CI green for every commit (`verify-history.sh` output)
- [ ] Clean-checkout run: `.env.example → .env`, typecheck, lint, test, build, adversarial
- [ ] `docker compose up` + smoke through nginx
- [ ] Mutation check: rate limiter, auth guard, validator, concurrency guard → tests failed, code restored
- [ ] Working tree clean

## 10. Acceptance results

_To be filled with command output summaries as checks run._

| # | Result | Evidence |
|---|---|---|
| 1–17 | pending | — |
