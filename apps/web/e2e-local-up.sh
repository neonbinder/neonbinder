#!/bin/bash
# ─── Local E2E harness: persistent workers on the REAL NEO-49 Convex queue ────
# Starts WORKERS (default 2) persistent `run-e2e-queue.sh` daemon workers that
# drain the SAME Convex /e2e queue CI uses, against the dev deployment + local
# Vite. Identical runner, claim, run, report path as CI → local == CI. Each
# worker bootstraps ONCE (staggered, since all workers share one dev SL/BSC
# account — concurrent cold logins = 503, the NEO-46 trap), then drains forever.
#
# Agents (or you) drip flows and watch:
#   ./e2e-enqueue.sh .maestro/flows/set-selector/team-picker.yaml
#   ./e2e-watch.sh   .maestro/flows/set-selector/team-picker.yaml
#
# HARD RULE: these are the ONLY maestro processes. Agents ENQUEUE + WATCH; never
# run `maestro` / `npm run test:e2e*` directly (extra Chrome → laptop crash +
# global-state contention). Replaces the /tmp/...lock spawn-per-test model.
#
# Prereqs (you start these): local Vite at $APP_URL + Convex dev backend pushing
# THIS branch's functions to dev (npm run dev:all). The new /e2e/add + /e2e/flow
# endpoints must be live on dev (they deploy with `npx convex dev`).
#
# Knobs: WORKERS, APP_URL (https://localhost:3000), BOOTSTRAP_STAGGER (sec),
#   CONVEX_SITE_URL / E2E_QUEUE_SECRET (auto-resolved from dev if unset),
#   E2E_RUN_ID (default local-<epoch>), MAESTRO_HEADLESS (1 = CI viewport).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

WORKERS="${WORKERS:-2}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--XX:+UseSerialGC}"   # kills the intermittent G1 SIGSEGV
export MAESTRO_HEADLESS="${MAESTRO_HEADLESS:-1}"                    # headless = CI's 1024×629 viewport
export APP_URL="${APP_URL:-https://localhost:3000}"
BOOTSTRAP_STAGGER="${BOOTSTRAP_STAGGER:-90}"

mkdir -p .e2e-local maestro-report/logs
STOP_FILE="$ROOT/.e2e-local/stop"; rm -f "$STOP_FILE"

DOTENV=()
[ -f .env.convex ] && DOTENV=(npx dotenv-cli -e .env.convex --)

# Resolve the dev .convex.site (HTTP-actions) URL from the cloud URL.
if [ -z "${CONVEX_SITE_URL:-}" ]; then
  cloud="${VITE_CONVEX_URL:-}"
  if [ -z "$cloud" ] && [ -f .env.local ]; then
    cloud="$(grep -E '^VITE_CONVEX_URL=' .env.local | head -1 | sed -E 's/^VITE_CONVEX_URL=//; s/^["'\'']//; s/["'\'']$//')"
  fi
  [ -z "$cloud" ] && { echo "✗ Could not resolve CONVEX_SITE_URL. Export CONVEX_SITE_URL or VITE_CONVEX_URL (the dev deployment URL)." >&2; exit 1; }
  CONVEX_SITE_URL="${cloud/.convex.cloud/.convex.site}"
fi

# Resolve the queue secret from the dev deployment (suppressed; never printed).
if [ -z "${E2E_QUEUE_SECRET:-}" ]; then
  E2E_QUEUE_SECRET="$("${DOTENV[@]}" npx convex env get E2E_QUEUE_SECRET 2>/dev/null | tr -d '\r\n')"
  [ -z "$E2E_QUEUE_SECRET" ] && { echo "✗ E2E_QUEUE_SECRET not found on the dev deployment. Set it: npx convex env set E2E_QUEUE_SECRET <value>" >&2; exit 1; }
fi
export CONVEX_SITE_URL E2E_QUEUE_SECRET
E2E_RUN_ID="${E2E_RUN_ID:-local-$(date +%s)}"; export E2E_RUN_ID

# Share run context with enqueue/watch (gitignored; holds the dev queue secret).
umask 077
{ echo "E2E_RUN_ID=$E2E_RUN_ID"; echo "CONVEX_SITE_URL=$CONVEX_SITE_URL"; echo "E2E_QUEUE_SECRET=$E2E_QUEUE_SECRET"; } > .e2e-local/env

# Sanity: queue reachable on dev?
if ! curl -fsS -X POST "$CONVEX_SITE_URL/e2e/status" -H "x-e2e-queue-secret: $E2E_QUEUE_SECRET" \
      -H "Content-Type: application/json" -d "{\"runId\":\"$E2E_RUN_ID\"}" >/dev/null 2>&1; then
  echo "✗ Queue not reachable at $CONVEX_SITE_URL/e2e/status. Is the Convex dev backend up with this branch's functions deployed?" >&2
  exit 1
fi

echo "── local E2E harness ──"
echo "   runId=$E2E_RUN_ID  workers=$WORKERS  APP_URL=$APP_URL  headless=$MAESTRO_HEADLESS"
echo "   site=$CONVEX_SITE_URL"
echo "   enqueue: ./e2e-enqueue.sh <flow>   watch: ./e2e-watch.sh <flow>   stop: Ctrl-C"

pids=()
cleanup() {
  echo; echo "stopping workers…"; touch "$STOP_FILE"
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null; rm -f "$STOP_FILE"; exit 0
}
trap cleanup INT TERM

# Worker keeper: a maestro JVM can intermittently SIGSEGV on this laptop (even
# with SerialGC above). Without supervision a crashed worker stays dead and the
# harness silently stops draining (the whole stack then looks "hung"). Mirror
# vite-keeper: relaunch the daemon worker whenever it exits, until the stop
# sentinel appears. Each relaunch re-runs Phase 0 bootstrap, so it comes back
# clean. A persistent crash can't busy-loop — bootstrap alone takes ~1-2 min.
worker_keeper() {
  local i="$1"
  while [ ! -f "$STOP_FILE" ]; do
    E2E_QUEUE_DAEMON=1 E2E_QUEUE_STOP_FILE="$STOP_FILE" RUNNER_INDEX="$i" \
      PATH="$HOME/.maestro/bin:$PATH" ./run-e2e-queue.sh worker
    local rc=$?
    [ -f "$STOP_FILE" ] && break
    echo "[worker-keeper] worker $i exited (rc=$rc) at $(date '+%H:%M:%S'); restarting in 3s" | tee -a "maestro-report/logs/runner-$i.log"
    sleep 3
  done
}

for i in $(seq 0 $((WORKERS - 1))); do
  if [ "$i" -gt 0 ]; then echo "… staggering ${BOOTSTRAP_STAGGER}s before worker $i bootstrap (shared SL/BSC account)"; sleep "$BOOTSTRAP_STAGGER"; fi
  echo "▶ launching worker $i (TEST_EMAIL_$i, keeper-supervised) — log: maestro-report/logs/runner-$i.log"
  worker_keeper "$i" &
  pids+=("$!")
done

echo "workers up (pids: ${pids[*]}). Live progress: tail -f maestro-report/logs/runner-*.log"
wait
