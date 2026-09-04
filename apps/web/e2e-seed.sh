#!/bin/bash
# ─── Seed the canonical E2E data (the setup track) ───────────────────────────
# Scripted reset (NEO-214 — no more "Reset Set Builder Data" button; see
# ./e2e-baseline.sh) THEN setup.yaml through the already-running local
# harness. NEO-62 (Lever 1): the track is now a single flow — Base + Insert +
# Parallel all run in one browser context, so there is no ordering concern
# and no sequential enqueue beyond that. After this completes the dev
# deployment holds ONLY the canonical pre-synced 2024 Topps Chrome (Base +
# Insert + Parallel) — this is a never-shared-dev, destructive reset, not an
# incremental seed. See ./e2e-baseline.sh --help for confirmation/deployment
# knobs (E2E_BASELINE_CONFIRM, --deployment/CONVEX_NAME); this script always
# runs it against the SAME deployment the harness (e2e-local-up.sh) resolved.
#
# Prereq: the harness must be up (./e2e-local-up.sh or `npm run e2e:local`) —
# this reads .e2e-local/env that the harness writes.
#
# Usage:  npm run e2e:local:seed       (or)   ./e2e-seed.sh
# Knob:   E2E_SEED_TIMEOUT (per-flow watch timeout, default 1200s)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

[ -f .e2e-local/env ] || { echo "✗ harness not running — start it first: npm run e2e:local" >&2; exit 1; }

echo "── scripted reset (e2e-baseline.sh reset) ──"
./e2e-baseline.sh reset || { echo "✗ reset failed — aborting seed." >&2; exit 1; }

SETUP_FLOWS=(
  .maestro/flows/setup.yaml
)
WATCH_TIMEOUT="${E2E_SEED_TIMEOUT:-1200}"

echo "── seeding canonical data (setup track, single flow) ──"
for f in "${SETUP_FLOWS[@]}"; do
  echo "▶ $f"
  ./e2e-enqueue.sh "$f" || { echo "✗ enqueue failed: $f" >&2; exit 1; }
  if ./e2e-watch.sh "$f" "$WATCH_TIMEOUT"; then
    echo "✅ $f"
  else
    echo "✗ $f did not pass — aborting seed." >&2
    echo "  forensics: maestro-report/debug/$(echo "$f" | sed -e 's|^\.maestro/flows/||' -e 's|/|_|g' -e 's|\.yaml$||')/" >&2
    exit 1
  fi
done
echo "✅ canonical data seeded — 2024 Topps Chrome Base + Insert + Parallel are live."
