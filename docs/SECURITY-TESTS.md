# Security and abuse tests

How they run: `pnpm --filter @ff/api test:adversarial` builds nothing; it starts the real stack from
the compiled code (`pnpm build` first): nginx (docker, host network), two api copies and three worker
processes as child processes (so they can be `kill -9`'d), the shop stub, real Postgres and Redis from
docker compose, the shared test clock, `.env.example` limits (except the rate-limit window, shortened
to 8 s so window behaviour can be tested). A malicious client with a chosen source IP
(`127.0.N.M`) attacks it over the network. Every concurrency test ends with the ledger check.
Harness: `apps/api/test/attacker/harness/`. Specs: `apps/api/test/attacker/specs/` (run in a fixed
order by `all.adv.spec.ts`; the last one checks the ledger of everything before it).
Faster in-process counterparts live in `apps/*/test/integration`.

| Attack | Expected | Actual | Test file | Status |
| --- | --- | --- | --- | --- |
| 300 simultaneous orders for 100 units, both api copies + nginx, 3 workers (#3) | exactly 100 reserved, 200 waiting, nothing negative | as expected | `acceptance-stock` | pass |
| Batches 10/40/90 days, shop minimum 30; minimum exactly / one day less (#4) | 40-day batch used, 10-day never touched | as expected | `acceptance-stock` | pass |
| 50 waiting orders (some express), two receipts of 10 at once; cancel racing the re-reserve (#5) | express first, then earliest, nobody twice | as expected | `acceptance-stock` | pass |
| Same last scan from 12 parallel calls on both copies; same key repeated 10x; other picker (#6) | one scan counted, same answer for repeats, other picker refused | as expected | `acceptance-floor` | pass |
| Cancel vs last scan (20 rounds); cancel vs packing (15 rounds) (#7) | cancelled with all in the return cell, or picked/packed and cancel refused | as expected | `acceptance-floor` | pass |
| Shortage; shortage vs a second picker on the same cell (#8) | cell blocked, reserve moved in the same transaction, never used after | as expected | `acceptance-floor` | pass |
| Count on a cell being picked, discrepancy 7; exactly 5 units / 10% / one over (#9) | count right, approval needed from the shift lead only | as expected | `acceptance-floor` | pass |
| Reassign vs scan; manual vs timer wave; A->B vs B->A moves | one consistent outcome, no raw deadlock | as expected | `acceptance-floor` | pass |
| Friday 17:01 Warsaw, spring DST day (#10) | ships Monday / next working day | as expected | `acceptance-jobs` | pass |
| Same order 10x at once to both copies; different content under the same number (#11) | one order, one reserve; ORDER_CONFLICT | as expected | `acceptance-jobs` | pass |
| Chaos webhooks: every 5th fails (500 / timeout) (#11) | every event delivered (counted at the stub), versions never go back, stock <= 1 per 5 s with the latest value | as expected | `acceptance-jobs` | pass |
| kill -9 workers mid-reserve and mid-wave (#12) | everything done once after restart | as expected | `acceptance-jobs` | pass |
| FLUSHALL and a Redis restart with live timers, waiting re-reserves, queued webhooks (#12) | nothing lost, nothing twice | as expected | `acceptance-jobs` | pass |
| Workers down, clock jumps three wave slots | one catch-up wave | as expected | `acceptance-jobs` | pass |
| Webhook endpoint down until retries run out | failed job visible to admin only, rerun exactly once | as expected | `acceptance-jobs` | pass |
| Lead on copy A, picker on copy B (#14) | scan and status seen in < 1 s | as expected | `acceptance-security` | pass |
| Other shop's order/SKU/stock/label/cancel by key and cabinet login (#15) | 404 / 403, nothing changes | as expected | `acceptance-security` | pass |
| Other warehouse's dashboard/tasks/counts/receipts/putaway/reports; other picker's task (#15) | 403 / 404 / TASK_NOT_ASSIGNED on both copies | as expected | `acceptance-security` | pass |
| Role escalation, mass assignment (`shopId`, `status`, `approvedBy`, `role`, ...) | 403 / 400 | as expected | `acceptance-security` | pass |
| Sockets: no token, forged token, wrong subscription; shop gets no internal data; flood | rejected / throttled | as expected | `acceptance-security` | pass |
| Ledger vs stock over the whole database after everything (#13) | equal per cell and batch, nothing negative | as expected | `zz-final-ledger` | pass |
| Token attacks (alg none, wrong secret, tampered, expired, not yet valid, missing/extra claims) | 401 on both copies | as expected | `auth-keys` | pass |
| Refresh reuse across copies, parallel refresh, logout, deactivation, removed role | family revoked, <= 1 winner, immediate lockout | as expected | `auth-keys` | pass |
| Login: unknown user vs wrong password | identical body, status, similar timing | as expected | `auth-keys` | pass |
| API keys: truncated, guessed, malformed, revoked | 401; stored hashed | as expected | `auth-keys` | pass |
| Parallel creation of the same barcode / cell / email / shop code; double-submitted receipt | exactly one | as expected | `auth-keys` | pass |
| Every route without credentials; wrong kind of principal | 401 / 403 in the shared error format | as expected | `input-transport` | pass |
| Hostile bodies (proto pollution, 4000-deep JSON, 50k-item arrays, null bytes, SQL, XSS, overflow) on every write route | never 5xx, never a leak | found bug #8 (HTML 413), fixed | `input-transport` | pass |
| Hostile query strings (SQL, wildcards, sort injection, bad pagination) on every read route | clean 4xx | as expected | `input-transport` | pass |
| Invalid time zone, cutoff 25:00, no working days, capacity <= 0, past expiry, overflow, inverted/oversized report period | 400 with field errors | as expected | `input-transport` | pass |
| 2 MB body, wrong content type, malformed JSON, CRLF and 70 KB headers, unexpected methods | 413 / 415 / 400 in the shared format | as expected | `input-transport` | pass |
| CORS from a disallowed origin; security headers | no ACAO for strangers; nosniff, no x-powered-by | as expected | `input-transport` | pass |
| Stored XSS in SKU names, customer, address; label PDF file name | inert JSON; safe PDF, id-only file name | as expected | `input-transport` | pass |
| 60 slowloris sockets + keep-alive burst from one address | another client unaffected (p95 < 1.5 s) | as expected | `input-transport` | pass |
| Login flood from IP X, innocent IPs Y and Z | X gets 429 + Retry-After; Y, Z 200 (p95 < 3 s) | as expected | `rate-limit` | pass |
| 60 parallel logins over both copies | exactly 20 pass | as expected | `rate-limit` | pass |
| Spoofed X-Forwarded-For / X-Real-IP / Forwarded (rotating; naming the victim); direct to an api copy | cannot evade, victim unaffected | as expected | `rate-limit` | pass |
| Account bucket across IPs; window recovery; key TTL; no raw IPs in Redis | as designed | as expected | `rate-limit` | pass |
| Redis stopped | requests served, per-copy limiter still limits (fail-open) | as expected | `rate-limit` | pass |
| Webhook to private / loopback / link-local addresses, redirects, slow receiver | blocked / not followed / other shops unaffected | found bug #6, #10, fixed | `apps/worker/test/integration/webhooks.int.spec.ts` | pass |
| Webhook signature: tampered body, wrong secret, stale timestamp, replay | rejected at the receiver | as expected | `apps/shop-stub/src/receiver.spec.ts` | pass |
| Browser: reload loses the session when refreshes race | session restored | found bug #9, fixed | `e2e/journeys.e2e.ts`, `apps/web/.../token-store.spec.ts` | pass |

## Not applicable or covered elsewhere

- *Magic links*: there are none; shop API keys are the shop's equivalent and are tested above.
- *IPv6 and IPv4-mapped source addresses*: nginx and the stack listen on IPv4 in the test setup, so the
  one-bucket rule is proven by unit tests (`client-ip.spec.ts`) rather than over the network.
- *Slow Redis (not down)*: the limiter's 250 ms timeout falls back to the local limiter exactly like
  "down"; covered by `rate-limiter.int.spec.ts` ("fail-open").
- *Test clock endpoint absent unless enabled*: proven in-process (`errors-openapi.int.spec.ts`), because
  the adversarial stack enables it on purpose.
- *Escaping in the web UI*: React escapes by default; the only raw HTML is the shop stub page, tested in
  `apps/shop-stub/test/stub.int.spec.ts`.
