# One image per service from a single build stage: the workspace is installed and built once,
# every service then starts its own entry point. Node 22 LTS.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.6.0
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/shop-stub/package.json apps/shop-stub/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.6.0
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
USER node

FROM runtime AS api
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/main.js"]

FROM runtime AS shop-stub
CMD ["node", "apps/shop-stub/dist/main.js"]

FROM runtime AS web
WORKDIR /app/apps/web
CMD ["node_modules/.bin/next", "start", "-p", "3001"]

# Applies migrations, then the idempotent seed, then exits (docker compose waits for it).
FROM runtime AS migrate
WORKDIR /app/packages/db
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/seed/run-seed.js"]
