# CLAUDE.md — standing rules for this repo

## Priority order (highest wins)

1. `ASSIGNMENT.md` — every requirement, no exceptions.
2. Approved `plan.md`.
3. This file.
4. Your own defaults.

If two levels conflict, follow the higher one and log the conflict in plan.md → "Deviations".

## Stack rule: the assignment decides the stack

Every technology named in this file (postgres, redis, nginx, docker compose, React, Next.js, and so on) is a DEFAULT, never a requirement. If the assignment forbids, replaces or omits a technology, do not use it. Drop its block from the commit plan, its folder, its env vars, its compose service and its tests, and note it in plan.md → Deviations. Where a removed component had a job, implement that job with what the assignment allows, behind a small interface. Keep the same guarantees and keep the same tests, adapted to the new store. Never leave dead config, unused dependencies or empty folders for a removed technology.

## Paradigm

- **Classes only for NestJS constructs**: modules, controllers, providers/services, guards, interceptors, pipes, filters, gateways, BullMQ processors. Keep them thin: they wire dependencies and delegate to pure functions. No business logic in a class body. Instantiating library classes (PrismaClient, BullMQ Queue/Worker, Socket.IO adapter, PDF document) at the infra edge is fine.
- **Everything else is functional**: no `class`, no `this`, no inheritance. Pure functions, immutable data (`readonly`, `as const`, spread instead of mutate), composition over inheritance.
- Side effects live at the edges (db, redis, http, webhooks, PDF, clock, random). Inject them as parameters or via factories `createX(deps) => ({ ... })`. Never import a singleton inside a pure function. The clock is always injected, so tests can control time. The assignment requires this for the 15-minute waves, cutoff, expiry dates and the 5-second webhook window.
- Expected failures are values (`Result<T, E>`), for example `INSUFFICIENT_STOCK`, `WRONG_CELL`, `WRONG_BATCH`, `CELL_BLOCKED`, `ALREADY_SCANNED`, `INVALID_TRANSITION`. Throw only for programmer errors and unexpected states.
- Named exports only. No default exports. No barrel files that re-export whole folders, except FSD public APIs. **One exception:** Next.js route files (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `template.tsx`, `default.tsx`) and tool config files that require a default export may use `export default`. Keep those files as thin wrappers that import named exports from `src/pages`. Do not log this as a deviation.
- TypeScript `strict`. No `any`, no `@ts-ignore` without a one-line reason, no non-null `!` assertions. Validate every external input (HTTP bodies, shop API requests, socket messages, job payloads, scanner input, shop stub input) with zod at the boundary and infer types from the schemas.

## Frontend: Feature-Sliced Design (strict)

```
apps/web/src/
  app/        providers, global styles, entry
  pages/      route-level composition
  widgets/    large self-contained UI blocks (shift dashboard, pick route, stock table)
  features/   user actions that deliver business value (scan, report shortage, cancel order, approve adjustment, start wave)
  entities/   business entities (types, api, UI): order, sku, cell, batch, wave, pick task, warehouse, shop
  shared/     ui kit, api client, lib, config. No business logic.
```

- A layer may import only from layers below it. Never import sideways between slices on the same layer.
- Each slice has segments by purpose: `ui/`, `model/`, `api/`, `lib/`, `config/`. Import a slice only through its `index.ts` public API, never its internals.
- Enforce this with a linter (`steiger` or `eslint-plugin-boundaries`) and make violations fail lint.
- Components are functions with hooks. UI holds no business rules. Rules live in pure functions in `model/` or `lib/`.
- Scanner screens: a scanner is keyboard input ending in Enter. Picking and packing work with no mouse: autofocus, focus recovery, Enter submits, a sound and a clear message on a bad scan. Each scan carries a client-generated idempotency key.
- Report period, filters, search and pagination live in the URL (survive reload and "Back"). The shift dashboard and the shop stock page update live over Socket.IO. Time to cutoff uses the server clock. Forms show errors at the fields.

### FSD inside Next.js (App Router)

Next owns the root `app/` folder for routes, and FSD's `app` and `pages` layers both clash with Next's folders. Use this layout:

- Root `apps/web/app/` holds only Next route files (`page.tsx`, `layout.tsx`, route handlers). Each one is a thin re-export or composition of a page from `src/pages`.
- All FSD layers live in `apps/web/src/` (`app`, `pages`, `widgets`, `features`, `entities`, `shared`).
- Add an empty `apps/web/pages/README.md` so Next never treats `src/pages` as a Pages Router.
- Server Components are allowed, but business rules still live in pure functions in `model/` or `lib/`, or in `packages/shared`.
- The API client is generated from OpenAPI into `shared/api`. Never hand-edit generated code, and regenerate it with a script.

## Backend structure (applies to `apps/api` and `apps/worker`)

```
apps/api/src/
  config/env.ts        zod-parsed env, the only reader of process.env
  main.ts, app.module.ts
  modules/<domain>/    e.g. auth, staff, shops, api-keys, warehouses, cells, skus, orders, receiving,
                       putaway, moves, transfers, reservation, waves, picking, packing, shipping,
                       inventory-count, reports, webhooks, jobs-admin, realtime
    <domain>.module.ts | .controller.ts | .service.ts   (Nest classes, thin)
    domain/            pure business logic, no framework imports
    dto/               zod schemas + inferred types
    repo/              data access functions
    *.spec.ts          tests next to the code
  common/              guards, filters, interceptors, pipes, rate limiter
  infra/               db, redis, queue, socket adapter, webhook http client, pdf, clock, factories
```

One folder per responsibility. A file has one reason to change and stays under about 200 lines. Business rules in `domain/` must be testable without Nest, db or redis.

## Repo layout

`apps/api`, `apps/worker`, `apps/web`, `apps/shop-stub`, `packages/shared`, `infra/{nginx,db,redis}`, `docker-compose.yml`, `.env.example`, `docs/`, `plan.md`, `CLAUDE.md`, `ASSIGNMENT.md`.

`packages/shared` holds zod schemas, rule constants and pure calculations, and contains no framework code and no IO:

- shipping-day and cutoff calculation (warehouse time zone, working days, holidays, DST);
- FEFO and minimum-shelf-life rules;
- warehouse selection for a reserve;
- re-reserve priority;
- wave selection and priority;
- inventory thresholds;
- order status transition rules;
- webhook coalescing and version rules.

`api`, `worker` and `web` all import from it, so a rule exists in exactly one place.

Defaults, used ONLY where the assignment is silent: pnpm workspaces, TypeScript strict, docker compose. Where the assignment names a stack (PostgreSQL 16, Prisma, Redis 7, BullMQ, NestJS, `@nestjs/swagger`, Socket.IO, Next.js 15, React 19, TanStack Query, React Hook Form, Tailwind, Vitest, Playwright), use exactly that. Log each default you use as an assumption.

Known integration points (solve them, do not work around them):

- **OpenAPI from zod:** schemas live in `packages/shared` as zod. `@nestjs/swagger` needs DTO classes, which are allowed because they are Nest constructs. Use `nestjs-zod` (or equivalent) so the DTO classes are generated from the shared zod schemas, and the OpenAPI document stays the single source for the generated web client. Error responses use one shared error schema with a stable `code` and are declared on every endpoint. No response type is written by hand.
- **Vitest + NestJS decorators:** Vitest's default transform drops decorator metadata. Use an SWC plugin (`unplugin-swc`) in the Vitest config for api and worker.
- **Socket.IO across two api copies:** use the Redis adapter. Room joins are authorized on the server. After a Redis loss, clients reconnect and catch up from Postgres.
- **Shared test clock across processes:** api and worker copies must see the same test time (for example, an offset row in Postgres or a test-only endpoint, enabled only by env).

## Data rules

- The database is the single source of truth. Redis holds only disposable state (BullMQ job copies, Socket.IO adapter, presence, rate-limit counters). Losing all of Redis must lose no wave timers, re-reserves, webhooks, reserve expiries or nightly jobs. Every pending action has a due-at row in Postgres, and a reconciler rebuilds BullMQ jobs from it (deterministic job ids). Prove it with a test (`FLUSHALL` with live timers).
- Movement ledger: every stock change (receipt, putaway, reserve, unreserve, pick, ship, move, transfer, adjustment) is an append-only row recording what, how much, from where, to where, who, when and which document. Balances change only in the same transaction as their ledger rows, with `CHECK` constraints so on-hand and reserved never go negative and reserved never exceeds on-hand. Current stock always equals the ledger sum, and a test checks it.
- Use raw SQL with explicit locks or constraints (`SELECT ... FOR UPDATE [SKIP LOCKED]`, unique, partial unique and check constraints, advisory locks) wherever Prisma alone cannot guarantee correctness:
  - reserve and re-reserve: lock balance rows in a deterministic order, with a bounded retry on deadlock or serialization failure;
  - order-import dedup by (shop, external number) plus a payload hash;
  - a scan counted once: idempotency-key unique, `picked_qty <= qty`;
  - cancel vs scan vs pack: conditional status updates;
  - shortage: block the cell and move the reserve in one transaction;
  - a stock count vs picking: cell lock, one open count per cell;
  - one wave formation per warehouse and one wave per order;
  - per-SKU webhook versions that are monotonic.

  Every state change is idempotent and safe to retry.

- Jobs are idempotent: processing the same job twice, or on two or three worker copies at once, must have the same effect as once. Side effects that leave the system (webhooks) use an outbox row with a state machine, so a retry never produces a duplicate or out-of-order event. A job that exhausts its attempts is recorded, visible to the admin and can be rerun manually.
- Seed: set-based and idempotent, consistent with the ledger, with size controlled by env (small for CI, full for compose).

## Environment

- `.env.example` lists EVERY variable with a comment and a safe placeholder. It is committed. `.env` is gitignored and copied from the example.
- Each app (`apps/api`, `apps/worker`, `apps/web`, `apps/shop-stub`) has its own `src/config/env.ts`. For web, server-only variables and `NEXT_PUBLIC_*` variables are validated separately. Each file contains a zod schema, `safeParse(process.env)`, a readable error and exit on failure. Defaults for NON-sensitive variables only (ports, timeouts, limits, wave interval, coalesce window, log level, seed size). Secrets (JWT secret, db password, webhook HMAC secrets, API-key pepper) are required and have no default. Export one typed `Object.freeze`d `env`.
- Nothing else touches `process.env`. docker compose and tests also read from the same `.env`.

## Security baseline

- Passwords: argon2id or bcrypt with sane cost. Tokens: short-lived access plus rotating refresh with reuse detection.
- Shop API keys: random, stored hashed, shown once, revocable, scoped to one shop.
- Webhooks: HMAC-signed over the timestamp and raw body, no redirects followed, with timeouts.
- Constant-time comparisons for secrets. Generic auth errors, so no user enumeration.
- Parameterized queries only. Strict body-size and content-type limits (larger gets `413`). Helmet-style headers. CORS allowlist from env.
- Permissions are checked on the server in every endpoint AND every socket subscription:
  - a shop sees only its own SKUs, orders, stock and labels, both in the cabinet and by API key;
  - an employee sees only their warehouses;
  - a picker sees only their own tasks;
  - a shift lead approves adjustments, starts waves and reassigns tasks at their warehouse;
  - an admin manages warehouses, cells, shops, staff and failed jobs.
- **Rate limiting by real client IP is required.**
  - Every limit and window is an env variable. The test and load profile sets them so no acceptance scenario trips them: acceptance #3 sends 300 simultaneous orders, #11 sends 10 duplicates through both copies, and the shop stub's chaos mode, scans and sockets must keep working.
  - Keyed by the real client IP (and by account or API key where relevant), stored in Redis with atomic operations (Lua or INCR+EXPIRE). Limits hold across both api copies. Losing Redis only resets counters. `X-Forwarded-For` is honored only from nginx and is spoofing-proof. Document fail-open vs fail-closed.
  - The adversarial limiter tests in the skill apply to it.
- Never log secrets, tokens, API keys, HMAC secrets or passwords.

## Testing philosophy

Tests exist to find bugs. A test that cannot fail is worthless.

- Unit: pure domain functions, with edge cases, boundaries and property-style inputs: shipping day across DST nights in Kyiv and Warsaw, cutoff exactly at the boundary, Friday after cutoff, non-working days, FEFO with equal expiries, minimum shelf life at the boundary, inventory thresholds, wave triggers, the full status transition table.
- Integration: Nest app against real postgres and redis (docker compose or testcontainers). No mocking the db or redis in integration tests. Every invariant has a test. Every concurrency test ends with the ledger-balance check.
- Adversarial/E2E: real server, real network, real malicious client. Follow `.claude/skills/adversarial-testing/SKILL.md`. Required for auth, API keys, the rate limiter, routes, sockets, input handling, inbound orders, webhooks, jobs and anything sensitive.
- Frontend: test model/lib functions and key feature flows with Vitest. Add a boundary lint for FSD.
- E2E: Playwright against the full docker compose stack (nginx, two `api` copies, worker, web, shop stub), covering the main user journeys the assignment lists.
- After writing security and concurrency tests, run a mutation check: disable the protection and confirm the test fails. Restore it.
- No `.skip`, `.only` or flaky sleeps (poll with timeouts instead). Time is controlled through the injected clock, never by real waiting. Tests are deterministic and parallel-safe.

## CI (required by the assignment: CI on every commit)

- `.github/workflows/ci.yml` is created in the FIRST commit, and every later commit passes it.
- Jobs:
  - install with a frozen lockfile;
  - typecheck;
  - lint (including the FSD boundary lint);
  - regenerate the OpenAPI client and fail on any diff (`git diff --exit-code`);
  - unit tests;
  - integration tests with real postgres and redis as services;
  - build;
  - an e2e job that runs docker compose plus Playwright, once those parts exist.

  CI uses the small seed profile.

- Run the same commands locally before each commit (nothing is pushed, so local runs are the evidence).

## Git

- Never push. History reflects stages of work (the assignment says so). Commit only complete blocks (see the plan.md commit plan), about 10–12 commits total. Each commit builds and is green in CI.
- Before every commit: typecheck, lint, test and build are green, and the working tree contains only that block.
- Conventional Commits, for example `feat(worker): wave scheduler with Postgres reconciler`. The body lists what the block contains and what its tests prove.
- Never commit `.env`, secrets or `node_modules`.

## Working rules

- Run it. Never claim something works without executing it and reading the output.
- After the plan is approved, do not ask questions. Decide, log the decision in plan.md "Assumptions", and continue. Stop only for a true blocker.
- Do not stop after a commit. Update the plan.md checklist and continue to the next block until the finish line is met.
- Do not skip, stub or leave TODOs for any assignment requirement. No `console.log`, commented-out code or dead files left behind.
- Keep plan.md current. It is the memory of this job if the context resets.
- The assignment requires decisions on ambiguous points to be written in the README. Log each decision in plan.md "Assumptions" as you make it, and make sure it ends up in the README's decisions section.
- The README must contain every section the assignment lists, plus the order status transition table (who, from which status, to which), and it must match actual behavior. Log the README language as an assumption.
