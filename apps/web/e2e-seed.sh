#!/bin/bash
# ─── Seed the canonical E2E data (NEO-339: scripted reset + setbuild) ────────
# The local twin of e2e.yml's `seed` / `seed-mobile` jobs:
#   1. ./e2e-seed-reset.sh — `e2e-baseline.sh reset` (NEO-214), plus, with
#      NB_REFERENCE_BUNDLE set, the NEO-330 reference-catalogue load;
#   2. `npm run setbuild -- apply` of the declarative baseline spec
#      (playwright/seed/baseline.spec.json): setbuild signs in as the worker-0
#      test admin and drives the same public admin Convex functions the Set
#      Builder UI calls (2024 Topps Chrome Base + Insert + Parallel, Big
#      League, 2026 Bowman's SportLots review, ...);
#   3. `setbuild apply` of playwright/seed/parallel.spec.json — the one base
#      parallel the baseline builds from Base (CI builds it through
#      `setbuild mcp-smoke`, which needs the MCP server; same row, same
#      server path).
# There is no Playwright project in the seed: the specs read what this builds.
# Destructive: the reset empties its target. Never point it at shared dev
# while other sessions use it (CLAUDE.md, Local E2E rule 3); prefer a PR
# preview. See docs/operations/neo339-setbuild.md for the tool.
#
# Target: CONVEX_NAME (the deployment slug, e.g. a PR preview's) is REQUIRED,
# and both the reset and the apply are given exactly that deployment, never
# left to their own default resolution (.env.local's CONVEX_DEPLOYMENT may
# still name dev while your Vite points at a preview).
#
# Auth: `--auth testing` against the Vite at $APP_URL (default
# http://localhost:3000), which must be wired to the same deployment.
# TESTING_ENDPOINT_SECRET and VITE_CLERK_PUBLISHABLE_KEY are read from
# .env.local (--env-file; values already in your environment win) and must be
# the ones the running Vite uses. The confirm phrase is computed offline by
# `setbuild confirm-phrase` for that deployment and that spec's content
# (BUILD <host> <scope> <digest>): the apply cannot land anywhere else, nor
# run a spec other than the one the phrase was made for.
#
# Usage:  CONVEX_NAME=<slug> APP_URL=http://localhost:3002 npm run test:e2e:seed
# Knobs:  APP_URL, PAUSED_PLATFORMS (match the target's NEONBINDER_PAUSED_PLATFORMS),
#         E2E_SEED_SPEC (default playwright/seed/baseline.spec.json),
#         NB_REFERENCE_BUNDLE (load prod's catalogue after the reset, as CI
#         does — ./e2e-seed-reset.sh, docs/operations/neo330-reference-seed.md)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

[ -n "${CONVEX_NAME:-}" ] \
  || { echo "✗ CONVEX_NAME is required: the deployment slug to reset and seed (e.g. the PR preview's)." >&2; exit 1; }
export CONVEX_NAME

SPEC="${E2E_SEED_SPEC:-playwright/seed/baseline.spec.json}"
PARALLEL_SPEC="playwright/seed/parallel.spec.json"
for f in "$SPEC" "$PARALLEL_SPEC"; do
  [ -f "$f" ] || { echo "✗ spec not found: $f" >&2; exit 1; }
done
CONVEX_URL="https://${CONVEX_NAME}.convex.cloud"
# Offline: parses the spec and hashes it; no network, no sign-in. A spec that
# does not parse stops here, before the reset.
PHRASE="$(npm run --silent setbuild -- confirm-phrase --spec "$SPEC" --convex-url "$CONVEX_URL")" \
  || { echo "✗ could not compute the confirm phrase for $SPEC (see above)." >&2; exit 1; }
PAR_PHRASE="$(npm run --silent setbuild -- confirm-phrase --spec "$PARALLEL_SPEC" --convex-url "$CONVEX_URL")" \
  || { echo "✗ could not compute the confirm phrase for $PARALLEL_SPEC (see above)." >&2; exit 1; }
APP_URL="${APP_URL:-http://localhost:3000}"
ENV_FILE_ARGS=()
[ -f .env.local ] && ENV_FILE_ARGS=(--env-file .env.local)

# The reset (and, with NB_REFERENCE_BUNDLE set, the NEO-330 reference
# catalogue load) is e2e-seed-reset.sh's job, shared with CI's seed jobs.
./e2e-seed-reset.sh || { echo "✗ reset failed — aborting seed." >&2; exit 1; }

apply() {  # spec phrase report
  npm run setbuild -- apply \
    --spec "$1" \
    --auth testing \
    --app-url "$APP_URL" \
    --convex-url "$CONVEX_URL" \
    --worker 0 \
    --paused-platforms "${PAUSED_PLATFORMS:-}" \
    --confirm "$2" \
    --report "$3" \
    ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"}
}

echo "── seeding canonical data (setbuild apply $SPEC → $CONVEX_NAME, app $APP_URL) ──"
if ! apply "$SPEC" "$PHRASE" setbuild-seed-report.json; then
  echo "✗ setbuild apply did not finish — aborting seed." >&2
  echo "  An open decision prints as a fill-in template above; see docs/operations/neo339-setbuild.md." >&2
  exit 1
fi
echo "── building the seeded base parallel (setbuild apply $PARALLEL_SPEC) ──"
if ! apply "$PARALLEL_SPEC" "$PAR_PHRASE" setbuild-parallel-report.json; then
  echo "✗ the seeded parallel did not build — aborting seed." >&2
  exit 1
fi
echo "✅ canonical data seeded (reports: setbuild-seed-report.json, setbuild-parallel-report.json)."
