#!/usr/bin/env bash
# Acceptance #2: every commit builds and is green. Checks out each commit into its own worktree
# and runs what CI runs (frozen install, build, generated files unchanged, typecheck, lint, tests).
# Needs the docker compose postgres + redis (integration tests). Usage: pnpm verify-history [from-ref]
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
FROM="${1:-}"
WORK="$(mktemp -d)"
trap 'git -C "$ROOT" worktree prune; rm -rf "$WORK"' EXIT
COMMITS=$(git -C "$ROOT" rev-list --reverse HEAD)
[ -n "$FROM" ] && COMMITS=$(git -C "$ROOT" rev-list --reverse "$FROM"..HEAD)
fail=0
for c in $COMMITS; do
  subject="$(git -C "$ROOT" log -1 --format=%s "$c")"
  dir="$WORK/$c"
  git -C "$ROOT" worktree add --detach "$dir" "$c" >/dev/null 2>&1
  cp "$ROOT/.env" "$dir/.env" 2>/dev/null || cp "$dir/.env.example" "$dir/.env"
  echo "=== ${c:0:7} $subject"
  if ( cd "$dir" \
      && pnpm install --frozen-lockfile >/dev/null 2>&1 \
      && pnpm build >/dev/null 2>&1 \
      && { [ ! -d apps/api ] || [ ! -f apps/api/openapi.json ] || { pnpm --filter @ff/api openapi:export >/dev/null 2>&1; git diff --exit-code -- apps/api/openapi.json >/dev/null; }; } \
      && { [ ! -d apps/web/src/shared/api/generated ] || { pnpm --filter @ff/web api:generate >/dev/null 2>&1; git diff --exit-code -- apps/web/src/shared/api/generated >/dev/null; }; } \
      && pnpm typecheck >/dev/null 2>&1 \
      && pnpm lint >/dev/null 2>&1 \
      && pnpm test >/dev/null 2>&1 \
      && pnpm test:int >/dev/null 2>&1 ); then
    echo "    green"
  else
    echo "    FAILED"; fail=1
  fi
  git -C "$ROOT" worktree remove --force "$dir" >/dev/null 2>&1 || true
done
[ "$fail" -eq 0 ] && echo "all commits are green" || { echo "some commits failed"; exit 1; }
