# Adversarial testing

Goal: find bugs, not confirm the happy path. Every test must be able to fail. Prefer few sharp tests over many shallow ones.

## Setup

- Real Postgres and Redis (docker compose or testcontainers). Never mock the db, Redis or BullMQ.
- Most tests run against the real Nest app listening on an ephemeral port, plus real worker processes. Only a small cross-stack suite uses nginx + two api copies + three workers: the multi-copy, client-IP and socket scenarios.
- Harness in `apps/api/test/attacker/`, as functional helpers:
  - `client({ sourceIp, auth })`: real HTTP, distinct IP via `localAddress: '127.0.0.N'`; auth is a staff token, a shop API key or none.
  - `burst({ n, fn })`: truly parallel requests with a start barrier.
  - `socket({ auth, apiCopy })`: a real Socket.IO client that records events.
  - `worker.kill9(i) / restart(i)`, `redis.flushAll()`.
  - `shopStub`: sends orders and reads the webhooks it received.
  - `ledger.assertBalanced()`: stock equals the sum of movements for every cell, SKU and batch; nothing negative; reserved ≤ on-hand.
  - `clock`: advances the shared test clock (never real sleeps).

## Concurrency and idempotency (most important)

End each of these with `ledger.assertBalanced()`. Run race tests in a short loop (about 20 iterations).

- **Scarce stock:** 300 parallel orders for an SKU with 100 on hand → exactly 100 reserved, 200 `awaiting_stock`, FEFO respected.
- **FEFO:** batches expiring in 10, 40 and 90 days with a shop minimum of 30 → the reserve comes from 40, and 10 is never touched. Also check the boundary where the remaining shelf life exactly equals the minimum.
- **Re-reserve:** receive 20 units with 50 orders waiting → express orders and the earliest orders get stock, and none gets it twice.
- **Duplicate order:** the same order sent 10× in parallel to both api copies → one order, one reserve. The same order number with different content → error.
- **Double scan:** two pickers scan the same line at once, plus a resend with the same idempotency key → one scan counts.
- **Cancel vs last scan or pack:** either the order is cancelled with all picked items in the return cell, or it is packed and the cancel is rejected. Never half of each.
- **Shortage:** the cell is blocked and the reserve moved in one transaction. A second picker can't take from that cell.
- **Stock count vs picking:** a scan in flight either commits before the lock and is counted, or is rejected. A difference of 7 units waits for shift-lead approval. Check the 5-unit and 10% thresholds exactly at the limit and one over.

## Jobs and Redis

- **Crash:** `kill -9` a worker mid-reserve and mid-wave, then restart it → everything finishes, with no double reserves or double waves.
- **Several workers:** three workers process the same job → the effect happens once.
- **Redis wiped:** `FLUSHALL` while wave timers, re-reserves and webhooks are pending → the reconciler rebuilds the jobs from Postgres, and each fires exactly once.
- **Failed job:** a job that has used up its retries is visible to the admin and can be retried once by hand.
- **Webhooks under chaos:** in the stub's chaos mode, every event arrives at the stub (count deliveries there), the HMAC signature is valid, stock versions never go backwards, and each SKU gets at most one update per 5 s carrying the latest value.

## Time edges

- Cutoff at 17:00: pack at 16:59:59, 17:00:00 and 17:00:01 → deterministic results matching the README.
- 17:01 on a Friday in Warsaw → ships the next working day.
- One DST transition in Warsaw and one in Kyiv.
- The wave at 14:59 vs 15:00, and the 49th, 50th and 51st ready order.

## Permissions

- **Route sweep:** iterate the Nest route table; every protected route returns 401 without credentials and 403 with the wrong role. This one test replaces dozens of hand-written ones.
- **IDOR:** shop A's API key or cabinet tries to touch shop B's order, SKU or stock → 404 or 403. An employee tries another warehouse, a picker tries another picker's task → refused.
- **Sockets:** an unauthenticated connection is rejected, a client can't join another shop's, warehouse's or picker's room, and a scan on copy B reaches the dashboard on copy A in under 1 s.
- **Tokens:** a tampered token, `alg: none`, an expired token, and reuse of an already-rotated refresh token → rejected, and the reuse revokes the whole token family.
- **Mass assignment:** extra fields such as `shopId`, `status` or `role` in a body are rejected or ignored.

## Rate limiter (per real client IP)

- **Flood:** A floods from IP X → 429 with `Retry-After`, while B and C on other IPs keep getting 2xx.
- **Spoofing:** a spoofed `X-Forwarded-For` neither bypasses A's limit nor blocks the victim's IP.
- **Shared limit:** the limit is total across both api copies, and N parallel requests can't exceed it.
- **Acceptance flows:** acceptance checks #3 (300 simultaneous orders) and #11 (10 duplicates) still pass with the configured limits.

## Input

- One table-driven test per endpoint group, fed with bad values: negative, zero and fractional quantities, an invalid time zone, a 25:00 cutoff, an oversized body (→ 413), malformed JSON, `__proto__`, and an SQL-injection string in search.
- Every error response matches the shared error schema with a stable code: never a bare 500, a stack trace or SQL.

## Rules

- Assert on status, body and db side effects, and check that unrelated shops or users are unaffected.
- Poll with a timeout instead of sleeping. Each test creates its own data so tests run in parallel.
- **Mutation check:** once green, temporarily disable the permission guard, one validator, the stock row lock (or the order unique constraint) and the rate limiter. The matching tests must fail. Restore the code and note the result in `docs/SECURITY-TESTS.md`.
- When a test finds a bug: keep the test, fix the code, and add a row to `docs/BUGS_FOUND.md`.

## Report

`docs/SECURITY-TESTS.md`: a table of attack | expected | result | test file, followed by the mutation-check results.
