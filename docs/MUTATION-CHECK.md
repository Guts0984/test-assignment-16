# Mutation check

For every protection below the matching tests were run first (green), then the protection was
disabled in the source, the same tests were run again and **had to fail**, then the file was
restored. `pnpm tsx scripts/mutation-check.ts` repeats the whole procedure and exits non-zero if
any mutation survives. Last run: every mutation was caught.

| Protection disabled | File | Result | Test that caught it |
| --- | --- | --- | --- |
| Rate limiter always allows | `apps/api/src/common/rate-limit/limiter.ts` | caught | `rate-limiter.int.spec.ts`: exactly `limit` requests pass, 500 parallel requests over two copies -> 50, window recovery |
| Auth guard lets every request in | `apps/api/src/common/auth/auth.guard.ts` | caught | `errors-openapi.int.spec.ts` (every protected route 401, shop key 403 on staff routes), `shop-isolation.int.spec.ts` |
| Input validator: order quantity accepts 0 and negatives | `packages/shared/src/schemas/common.ts` | caught | `schemas.spec.ts`: rejects zero qty, rejects negative qty |
| Concurrency guard: order row lock | `packages/core/src/orders/transition.ts` | caught | `floor-stock.int.spec.ts` "the order row lock": cancel, scan and pack must wait for the holder |
| Concurrency guard: stock balance row lock (reserve) | `packages/core/src/floor/ledger-ops.ts` | caught | `jobs.int.spec.ts`: 60 orders for 20 units across three workers -> exactly 20 |
| Concurrency guard: idempotency key claim (scan) | `packages/core/src/floor/idempotency.ts` | caught | `floor-flow.int.spec.ts`: the same scan repeated counts once |

## What the first run taught

The first run did **not** catch the removal of the order row lock: the looped in-process
"cancel vs last scan" race passes by luck without it, because other guards (CHECK constraints,
conditional updates) usually still prevent corruption. A deterministic test replaced luck: it holds
the order row in a transaction and proves that cancel, scan and pack all wait for it. The mutation
is caught since then.
