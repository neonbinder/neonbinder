#!/bin/bash
# run-e2e-like-ci.sh — run the full E2E suite locally with CI-equivalent
# conditions on the controllable axes.
#
# What this mirrors from CI:
#   - Maestro CLI + Java versions (enforced via check-e2e-env.sh)
#   - MAESTRO_PARALLELISM=3 (3 workers sharing one Convex deployment)
#   - No tag filter — runs smoke + regression in one pass
#   - Same env vars passed through (BSC/SL creds from .env.test if present)
#
# What stays divergent (intentional, this is the cross-platform coverage):
#   - Chromium build: Mac uses local Chrome, CI uses Linux setup-chrome@v1
#   - Scrollbar geometry: macOS overlay vs Linux WebKit-style
#   - OS-level rendering quirks
#
# If a flow passes via `npm run test:e2e` but fails this, the controllable
# axes have drifted. If it passes here but fails CI, suspect the Chromium
# divergence (see .maestro/README.md "Known divergences" section).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  E2E like-CI: enforcing pinned versions + parallelism=3"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Gate: refuse to run if Maestro/Java versions don't match the pins.
# This is the difference between "test:e2e" (uses whatever's installed)
# and "test:e2e:like-ci" (refuses to run on a drifted environment).
./check-e2e-env.sh

echo ""
echo "Starting suite with MAESTRO_PARALLELISM=3, no tag filter (matches CI)."
echo "Note: Vite must already be running locally (npm run dev:all)."
echo ""

# Match CI's invocation: full suite via run-e2e-smoke.sh with no tag arg.
# run-e2e-smoke.sh sources .env.test for credentials when present.
export MAESTRO_PARALLELISM="${MAESTRO_PARALLELISM:-3}"
export APP_URL="${APP_URL:-http://localhost:3000}"
export PATH="$HOME/.maestro/bin:$PATH"

exec ./run-e2e-smoke.sh
