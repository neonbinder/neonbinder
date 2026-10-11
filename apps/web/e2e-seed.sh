#!/bin/bash
# ─── Seed the canonical E2E data (NEO-339: scripted reset + setbuild) ────────
# Scripted reset (NEO-214 — no more "Reset Set Builder Data" button; see
# ./e2e-baseline.sh) THEN `npm run setbuild -- apply` of the declarative
# baseline spec (.maestro/seed/baseline.spec.json). There is no Maestro flow in
# the seed any more (flows/setup.yaml is gone): setbuild signs in as the
# worker-0 test admin and drives the same public admin Convex functions the Set
# Builder UI calls. This is a never-shared-dev, destructive reset, not an
# incremental seed. After it completes the deployment holds the baseline the
# spec describes (2024 Topps Chrome Base + Insert + Parallel, Big League,
# 2026 Bowman, ...). See ./e2e-baseline.sh --help for confirmation knobs
# (E2E_BASELINE_CONFIRM) and docs/operations/neo339-setbuild.md for the tool.
#
# The reset AND the apply are both passed the deployment derived from THIS
# harness's own CONVEX_SITE_URL (below) rather than left to their own default
# resolution (CONVEX_DEPLOYMENT in .env.local/.env.convex) — those are normally
# the same deployment, but not guaranteed: this repo's own worktree setup
# (CLAUDE.md) has a maintainer re-point VITE_CONVEX_URL (which e2e-local-up.sh
# derives CONVEX_SITE_URL from) at a PR's Convex preview while
# CONVEX_DEPLOYMENT in .env.local still names dev (F5). An unqualified reset in
# that shape would silently wipe the WRONG deployment — the one the harness
# ISN'T running against.
#
# Auth: `--auth testing` against the local Vite at $APP_URL (default
# http://localhost:3000). TESTING_ENDPOINT_SECRET and VITE_CLERK_PUBLISHABLE_KEY
# are read from .env.local (--env-file; values already in your environment win)
# and must be the ones the running Vite uses. The confirm phrase is built for
# the harness's own deployment: the apply cannot land anywhere else.
#
# Prereq: the harness must be up (./e2e-local-up.sh or `npm run e2e:local`) —
# this reads .e2e-local/env that the harness writes. Without a harness, export
# CONVEX_SITE_URL yourself (https://<deployment>.convex.site).
#
# Usage:  npm run e2e:local:seed       (or)   ./e2e-seed.sh
#         ./run-e2e-smoke.sh setup     (same thing)
# Knobs:  APP_URL, PAUSED_PLATFORMS (match the target's NEONBINDER_PAUSED_PLATFORMS),
#         E2E_SEED_SPEC (default .maestro/seed/baseline.spec.json)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

if [ -f .e2e-local/env ]; then
  # shellcheck disable=SC1091
  . .e2e-local/env
elif [ -z "${CONVEX_SITE_URL:-}" ]; then
  echo "✗ harness not running — start it first: npm run e2e:local (or export CONVEX_SITE_URL)" >&2
  exit 1
fi

CONVEX_SLUG="${CONVEX_SITE_URL#https://}"; CONVEX_SLUG="${CONVEX_SLUG%.convex.site}"
[ -n "$CONVEX_SLUG" ] && [ "$CONVEX_SLUG" != "$CONVEX_SITE_URL" ] \
  || { echo "✗ could not derive a deployment slug from CONVEX_SITE_URL='${CONVEX_SITE_URL:-}'" >&2; exit 1; }

SPEC="${E2E_SEED_SPEC:-.maestro/seed/baseline.spec.json}"
[ -f "$SPEC" ] || { echo "✗ spec not found: $SPEC" >&2; exit 1; }
SCOPE="$(jq -r '.scope // "e2e-baseline"' "$SPEC" 2>/dev/null)" || SCOPE="e2e-baseline"
APP_URL="${APP_URL:-http://localhost:3000}"
ENV_FILE_ARGS=()
[ -f .env.local ] && ENV_FILE_ARGS=(--env-file .env.local)

echo "── scripted reset (e2e-baseline.sh reset --deployment $CONVEX_SLUG) ──"
./e2e-baseline.sh reset --deployment "$CONVEX_SLUG" || { echo "✗ reset failed — aborting seed." >&2; exit 1; }

echo "── seeding canonical data (setbuild apply $SPEC → $CONVEX_SLUG, app $APP_URL) ──"
if npm run setbuild -- apply \
    --spec "$SPEC" \
    --auth testing \
    --app-url "$APP_URL" \
    --convex-url "https://${CONVEX_SLUG}.convex.cloud" \
    --worker 0 \
    --paused-platforms "${PAUSED_PLATFORMS:-}" \
    --confirm "BUILD ${CONVEX_SLUG}.convex.cloud ${SCOPE}" \
    --report setbuild-seed-report.json \
    ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"}; then
  echo "✅ canonical data seeded (report: setbuild-seed-report.json)."
else
  echo "✗ setbuild apply did not finish — aborting seed." >&2
  echo "  An open decision prints as a fill-in template above; see docs/operations/neo339-setbuild.md." >&2
  exit 1
fi
