# Bugs found by tests

Every row is a bug a test caught. The test stays in the suite.

| # | Attack / scenario | Impact | Root cause | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | Reserve 4 of 10 units on an existing balance row (any negative or reserve-only delta) | Every reserve, pick and unreserve failed with a CHECK violation: no stock could ever leave a cell | The ledger trigger used `INSERT ... ON CONFLICT DO UPDATE`; Postgres checks CHECK constraints on the proposed insert row (`on_hand 0, reserved 4`) before resolving the conflict | Trigger does `UPDATE` first and only `INSERT`s a missing row, retrying on `unique_violation` | `packages/db/test/constraints.int.spec.ts` ("a movement creates and updates the balance", "100 parallel reservers") |
| 2 | Every login (any freshly issued access token) | Nobody could authenticate: login returned 500 | `jsonwebtoken` drops a caller-supplied `iat` when `noTimestamp: true`, so the strict claim schema rejected every token | Sign without `noTimestamp`; the payload `iat` from the injected clock is kept | `apps/api/src/modules/auth/domain/tokens.spec.ts` ("round-trips") |
| 3 | Admin removes all roles of an employee (`PATCH /admin/staff/:id {roles: []}`), or sends an empty PATCH to a shop, warehouse or SKU | Role removal answered 404 and did not apply, so a removed employee kept access | Prisma `updateMany` with empty `data` reports 0 rows, which the service read as "not found" | Check existence explicitly, then update | `apps/api/test/integration/auth.int.spec.ts` ("a removed warehouse role takes effect immediately"), `shop-isolation.int.spec.ts` ("empty PATCH bodies") |
| 4 | An order whose SKUs have no stock anywhere (flaky, depended on random ids) | Stock arriving at warehouse B never reserved the order: it had been bound to warehouse A by the id tie-break, so waiting orders starved | Warehouse selection with zero coverage everywhere fell through to the "partial" tie-break and bound the order to the lowest warehouse id | Orders with no coverage anywhere stay unassigned (`awaiting_stock`, no warehouse); re-reserve at any warehouse adopts them | `apps/api/test/integration/floor-stock.int.spec.ts` ("acceptance #5 (small)") |
| 5 | Draining due background actions while thousands of other due rows (webhook streams) exist | Requested actions were starved: the 500-row window was filled before filtering by kind | `dueActions` applied `LIMIT` before the kind filter in application code | Kind filter moved into the SQL query | same test file (suite order dependent) |
| 6 | Webhook to a literal private IP (`http://169.254.169.254/...`, `http://127.0.0.1`) with private hosts disallowed | SSRF: the worker would call internal addresses | The guard lived in the DNS `lookup` hook, which Node skips for literal IP addresses | Literal IPs are checked before the request is made | `apps/worker/test/integration/webhooks.int.spec.ts` ("outbound safety") |
| 7 | Webhook signature timestamp taken from the shared test clock | Receivers rejected every webhook as stale as soon as the test clock was moved (e2e cutoff scenario) | Transport timestamp mixed up with business time | Signature uses real wall time; business time only affects event content | same test file ("chaos ... delivered exactly once") |
| 8 | A request body over 1 MB sent to any write route through nginx | The client got nginx's HTML error page instead of the shared JSON error body, so error handling that expects the documented format broke | nginx generated the 413 (and 400/429/5xx) itself | `error_page` mappings return the same `{ error: { code, message, requestId } }` JSON for every nginx-generated error | `apps/api/test/attacker/specs/input-transport.adv.spec.ts` ("hostile bodies on every write route") |
| 9 | Browser reload while signed in (found by the Playwright journeys) | The user was sent back to the login page: the session restore and the first API call each refreshed with the same rotating cookie at once; reuse detection revoked the family and the winning request ended in a 500 | Two parallel uses of one single-use refresh token, and `issue()` re-resolved the freshly signed token (which the loser had just revoked) | The client shares one in-flight refresh (`refreshOnce`), queries wait for the session, and the server builds the principal directly instead of re-resolving the token | `apps/web/src/shared/api/token-store.spec.ts`, `apps/api/test/integration/auth.int.spec.ts` ("parallel refresh"), `apps/api/test/attacker/specs/auth-keys.adv.spec.ts` |
| 10 | Any webhook to a host name (`http://shop-stub:4000/...`) in docker compose (found by the e2e journeys: the shop never got a status) | Every webhook failed with `network` and ended in the failed-jobs list | The SSRF guard's DNS hook returned one address, but Node asks for an address list (autoSelectFamily). Tests had used literal IPs, which skip DNS | The hook resolves all addresses, supports both callback shapes, and refuses a name if any answer is private | `apps/worker/test/integration/webhooks.int.spec.ts` ("delivers to a host NAME") |

## Found in an external review (fixed afterwards)

| # | Problem | Fix | Test |
| --- | --- | --- | --- |
| R1 | The per-account login limit was keyed by email alone, so anyone who knew an email could lock its owner out from any address | The account bucket is keyed by (client IP, email); the per-IP bucket still caps one address | `rate-limit.adv.spec.ts` ("a stranger hammering a known email ...") |
| R2 | A scan or shortage resent after a dropped connection got a new idempotency key and counted twice | The key is kept for an unconfirmed request and reused when the same scan is repeated; cleared on any definitive answer | `pick-scanner` flow; server idempotency already covered by `floor-flow.int.spec.ts` |
| R3 | Live pages stopped updating after the 15 minute access token: the socket kept the login-time token and was never reconnected after the server dropped it | Socket auth is a callback that returns a fresh token (refreshing when near expiry); the heartbeat sends a fresh token; a server-side disconnect triggers a reconnect | `use-live.ts`, `socket.ts` |
| R4 | After logout or role removal an open socket kept receiving shift-lead room events | The gateway re-resolves each socket's token every `SOCKET_PRESENCE_TTL_SEC / 3` and leaves every room the principal no longer holds (or disconnects) | `permissions-realtime.int.spec.ts` rights, gateway `recheck` |
| R5 | Receiving a transfer where one batch was sent from two cells booked units nobody reported | Received quantity is applied per (SKU, batch) across the sent lines in order; more than sent is refused | `regressions.int.spec.ts` ("one batch sent from two cells ...") |
| R6 | An explicitly named order could ship before its ship day | `shipOrders` checks `ship_day <= today` for named orders too | `regressions.int.spec.ts` ("not shipped before its ship day") |
| R7 | Two tabs refreshing at once ended in logout | Refreshes are serialised across tabs with a Web Lock; each reads the newest cookie | `mutator.ts` |
| R8 | The api copies and the stub ignored SIGTERM (exit 137) | Explicit graceful shutdown (close idle connections, app, three Redis clients, force exit after 8 s); stub handles SIGTERM; compose `init: true` | compose smoke |
| R9 | A picker could list and read every order of the warehouse (customer data) | Staff order list and detail need shift lead, storekeeper or packer (or admin) | `regressions.int.spec.ts` ("order visibility") |
| R10 | The shortage form could not be filled with a mouse: every click moved focus back to the scan field | Focus returns to the scan field only for clicks outside inputs and labels | `pick-scanner.tsx` |
| R11 | README said a job is finished in the same transaction as its effect | README corrected: finish is a separate conditional transaction; handlers are idempotent so a crash in between only retries | README |
| R12 | Report periods started at UTC midnight | Whole local days of each warehouse's time zone | `reports.ts` |
| R13 | Database down: `/api/health` and login answered 500 | New `UNAVAILABLE` (503) code for connection failures; `/api/health` answers 503; `/api/ready` checks database and Redis | `errors-openapi.int.spec.ts` |
| R14 | Scanning an already packed order said "not fully picked yet" and could not reprint | A packed order answers with the same result (label link) and no new event; a shipped one says it was shipped | `regressions.int.spec.ts` ("scanning a packed order again ...") |
| R15 | Spec conflict: packed orders cannot be cancelled although the spec says "until shipped" | Kept as documented decision D-3 (invariant 5: the order is already packed and labelled) | README decisions |
| R16 | The adversarial suite restarted any `fulfillment-redis*` container and removed any `ff-adv-nginx*` one | Each run starts its own Redis container (`ff-adv-redis-<pid>`) and cleanup only removes containers whose owning process is gone | harness |

## Second review round (problems in the first round of fixes)

| # | Problem | Fix | Test |
| --- | --- | --- | --- |
| S1 | A socket dropped while its token was still being checked kept a re-check timer forever (245 of 300 leaked, database load x4) | The timer starts only after the awaits and only if the socket is still connected; disconnect clears it | `regressions.int.spec.ts` ("socket timers"): 40 leaked timers without the fix |
| S2 | Two tabs refreshing together still logged everyone out (the Web Lock does not exist on plain HTTP and does not cover other browsers' profiles) | Server grace window `REFRESH_REUSE_GRACE_SEC` (10 s): a just-rotated token presented again gets a fresh token; later reuse still revokes the family | `regressions.int.spec.ts` ("refresh grace window"); strict specs run with grace 0 |
| S3 | `/api/ready` hung 60 s with Redis down | Dependencies are checked with a 2 s timeout | `ready()` |
| S4 | Worker exited 143 on a clean stop | `init: true` removed from the worker (it handles signals itself) | compose |
| S5 | Live sockets dropped once per token lifetime | The server re-check follows the fresh token sent by the heartbeat | gateway `presence` |
| S6 | No per-account cap across IPs after the lockout fix | Tried a cross-IP cap; third round showed it can be used up to lock the owner out, so it was removed (see T1) | - |
| S7 | 365-day report 4x slower | Per-warehouse day bounds are computed once per warehouse and joined (365 days about 0.37 s, 90 days about 0.09 s on the full seed) | perf |
| S8 | README said logins are limited by account | README describes the three login limits and the refresh grace window | README |
| S9 | README claimed ports avoid other projects | Wording removed; README says how to change the port | README |
| S10 | Packed orders cannot be cancelled although the spec says "until shipped" | Unchanged, decision D-3 | README |
| S11 | A `.env` made before the new variables turned them into blank values (login limit 0) | Compose supplies defaults for the two new variables | compose |

## Third review round

| # | Problem | Fix | Test |
| --- | --- | --- | --- |
| T1 | The cross-IP login cap (S6) let ~10 addresses use up the budget and lock the owner out, which the rules forbid | The cap is removed entirely: any limit shared by all addresses can be exhausted by an attacker. Only per-IP and per-(IP, account) limits remain; README states the cost | `rate-limit.adv.spec.ts` ("ten addresses hammering one known email ...") |
| T2 | A webhook event could be declared dead after 2 failed deliveries: the retry budget counted failed stream runs, so failures of earlier events used up the budget of later ones | The budget is the failing event's own attempt count (`failClaim` takes the attempt number reported by the handler); a manual rerun resets event attempts | `apps/worker/test/integration/webhooks.int.spec.ts` ("retry budget"): the stream went dead on the third run before the fix |
| T3 | A used refresh token could be replayed without limit inside the grace window (20 sessions from one token) | Each token counts its replays (`refresh_tokens.reuse_count`, migration 0005), at most 5 per token; further presentations are theft and revoke the family | `regressions.int.spec.ts` ("refresh grace limit") |

## Fourth review round

| # | Problem | Fix | Test |
| --- | --- | --- | --- |
| U1 | An item scanned before the answer to the cell scan arrived was sent as a cell scan ("Wrong cell"); E2E-2 failed locally on a slower machine | Scans are queued and processed one at a time against the latest task and step (refs updated synchronously) | `e2e/ui.e2e.ts` ("an item scanned before the answer ..."): fails after 21 s on the old code |
| U2 | The adversarial suite needs Linux (host networking) and left containers behind when its start failed | Clear error on other systems; a failed start removes its containers and processes | harness |
| U3 | A request address over about 8 KB got nginx's HTML 500 (named location cannot be used before the request line is parsed); oversized headers got an HTML 400 | `error_page 414 /_err414` and `431 494` return the shared JSON error | `input-transport.adv.spec.ts` |
| U4 | The report returned `p90Minutes: 456.00000000000006` | Minutes are rounded to two decimals | `floor-inbound.int.spec.ts` |
| U5 | The Docker subnet was fixed, so two stacks could not run side by side | `COMPOSE_PROJECT_NAME`, `NET_SUBNET`, `NET_IP_RANGE`, `NGINX_IP` in `.env` (defaults unchanged) | `docker compose config` |
| U6 | `docs/BUGS_FOUND_USER.md` was a pasted Prisma error | Deleted | - |
| U7 | Packed orders cannot be cancelled (spec: "until shipped") | Unchanged, decision D-3; CI coverage of every commit was left alone on request | - |

## Fifth review round

| # | Problem | Fix | Test |
| --- | --- | --- | --- |
| V1 | Many small headers totalling 16-32 KB passed nginx but were refused by Node with an empty 431 (no JSON body) | nginx header buffers are 4 x 3 KB, so nginx refuses first with the shared JSON error (checked: 15 KB passes, 16 KB and above get the JSON 431) | `input-transport.adv.spec.ts` (20 headers of 1 KB) |
