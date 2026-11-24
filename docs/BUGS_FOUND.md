# Bugs found by tests

Every row is a bug a test caught. The test stays in the suite.

| # | Attack / scenario | Impact | Root cause | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | Reserve 4 of 10 units on an existing balance row (any negative or reserve-only delta) | Every reserve, pick and unreserve failed with a CHECK violation: no stock could ever leave a cell | The ledger trigger used `INSERT ... ON CONFLICT DO UPDATE`; Postgres checks CHECK constraints on the proposed insert row (`on_hand 0, reserved 4`) before resolving the conflict | Trigger does `UPDATE` first and only `INSERT`s a missing row, retrying on `unique_violation` | `packages/db/test/constraints.int.spec.ts` ("a movement creates and updates the balance", "100 parallel reservers") |
| 2 | Every login (any freshly issued access token) | Nobody could authenticate: login returned 500 | `jsonwebtoken` drops a caller-supplied `iat` when `noTimestamp: true`, so the strict claim schema rejected every token | Sign without `noTimestamp`; the payload `iat` from the injected clock is kept | `apps/api/src/modules/auth/domain/tokens.spec.ts` ("round-trips") |
| 3 | Admin removes all roles of an employee (`PATCH /admin/staff/:id {roles: []}`), or sends an empty PATCH to a shop, warehouse or SKU | Role removal answered 404 and did not apply, so a removed employee kept access | Prisma `updateMany` with empty `data` reports 0 rows, which the service read as "not found" | Check existence explicitly, then update | `apps/api/test/integration/auth.int.spec.ts` ("a removed warehouse role takes effect immediately"), `shop-isolation.int.spec.ts` ("empty PATCH bodies") |
