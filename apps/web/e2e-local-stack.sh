#!/bin/bash
# ─── One-command local E2E stack ─────────────────────────────────────────────
# Brings up everything needed to validate Maestro flows locally the way CI does,
# in the right order:
#   1. push THIS branch's Convex functions to dev   (one-shot)
#   2. Vite at https://localhost:3000               (auto-restart keeper, pinned node)
#   3. the 2-worker persistent harness draining the real /e2e queue
# then blocks in the foreground. Ctrl-C tears the whole stack down (workers + Vite).
#
#   npm run e2e:local          # stack only — reuse the existing canonical data (fast)
#   npm run e2e:local:fresh    # stack + seed the canonical data (runs the setup track)
#
# Once up, authors validate flows from another terminal:
#   ./e2e-enqueue.sh <flow>  &&  ./e2e-watch.sh <flow>
#
# Knobs: WORKERS (2) · APP_URL (https://localhost:3000) · SKIP_CONVEX_PUSH=1
#        SEED=1 (or pass --seed) to run the setup track once the workers are up.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

SEED="${SEED:-}"
[ "${1:-}" = "--seed" ] && SEED=1
WORKERS="${WORKERS:-2}"
export APP_URL="${APP_URL:-https://localhost:3000}"

mkdir -p .e2e-local maestro-report/logs
rm -f .e2e-local/stop

VITE_PID=""; HARNESS_PID=""
cleanup() {
  echo; echo "── tearing down local E2E stack ──"
  [ -n "$HARNESS_PID" ] && kill "$HARNESS_PID" 2>/dev/null   # e2e-local-up traps → stops its workers
  touch .e2e-local/stop                                      # stop the vite-keeper restart loop
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null
  pkill -P "${VITE_PID:-0}" 2>/dev/null                      # nudge the keeper's npm/vite child
  wait 2>/dev/null
  rm -f .e2e-local/stop
  exit 0
}
trap cleanup INT TERM

# ── 1. Push this branch's Convex functions to dev (one-shot) ─────────────────
if [ -z "${SKIP_CONVEX_PUSH:-}" ]; then
  echo "▶ pushing this branch's Convex functions to dev (one-shot)…"
  if [ -f .env.convex ]; then
    npx dotenv-cli -e .env.convex -- npx convex dev --once --typecheck disable
  else
    npx convex dev --once --typecheck disable
  fi
fi

# ── 2. Vite (auto-restart keeper) in the background ──────────────────────────
echo "▶ starting Vite (auto-restart keeper)…"
./vite-keeper.sh &
VITE_PID=$!

# ── 3. Wait for Vite to answer before the harness bootstraps against it ──────
echo "▶ waiting for Vite at $APP_URL …"
ready=""
for _ in $(seq 1 90); do
  code="$(curl -k -s -o /dev/null -w '%{http_code}' "$APP_URL/" 2>/dev/null || true)"
  if [ "$code" = "200" ] || [ "$code" = "304" ]; then ready=1; echo "  Vite ready (http=$code)"; break; fi
  sleep 2
done
[ -z "$ready" ] && { echo "✗ Vite never became ready at $APP_URL" >&2; cleanup; }

# ── 4. Harness (background, so we can optionally seed, then foreground-wait) ──
echo "▶ starting harness (WORKERS=$WORKERS)…"
WORKERS="$WORKERS" ./e2e-local-up.sh &
HARNESS_PID=$!

# ── 5. Optionally seed canonical data once both workers are draining ─────────
if [ -n "$SEED" ]; then
  echo "▶ waiting for workers to finish bootstrap before seeding…"
  for _ in $(seq 1 300); do
    d0=0; d1=0
    grep -q "Draining queue" maestro-report/logs/runner-0.log 2>/dev/null && d0=1
    if [ "$WORKERS" -lt 2 ]; then d1=1
    else grep -q "Draining queue" maestro-report/logs/runner-1.log 2>/dev/null && d1=1; fi
    if grep -q "ERROR: bootstrap failed" maestro-report/logs/runner-*.log 2>/dev/null; then
      echo "⚠ a worker bootstrap failed — skipping seed (see maestro-report/logs/runner-*.log)" >&2; break
    fi
    if [ "$d0" = 1 ] && [ "$d1" = 1 ]; then
      echo "  workers draining — running setup track"; ./e2e-seed.sh || true; break
    fi
    sleep 3
  done
fi

echo "── stack up.  enqueue: ./e2e-enqueue.sh <flow>   watch: ./e2e-watch.sh <flow>   stop: Ctrl-C ──"
wait "$HARNESS_PID"
