#!/bin/bash
# ─── Vite auto-restart keeper ────────────────────────────────────────────────
# Keeps an app alive at http://localhost:3000 for local E2E, restarting Vite
# whenever it exits.
#
# HTTP, not HTTPS — this serves the URL run-e2e-smoke.sh defaults to, which is
# the same one CI drives (its maestro-runner proxy listens on plain
# http://localhost:3000). Under the mkcert HTTPS server, Chrome for Testing
# hangs after launchApp and every flow dies on a 180s getCurrentUrl timeout;
# see the APP_URL comment in run-e2e-smoke.sh. http://localhost is a secure
# context per spec, so Clerk and crypto.subtle are unaffected.
#
# Disabling mkcert also removes the reason this keeper exists: local Vite
# SIGSEGVs intermittently inside the mkcert plugin's bundled undici, which is
# what used to drop the app mid-flow. The restart loop stays as a belt-and-
# braces measure. Set VITE_DEV_DISABLE_HTTPS=0 to opt back into HTTPS (you will
# then also need APP_URL=https://localhost:3000).
#
# Node: the default `node` is too old for the undici that Vite pulls in
# (`webidl.util.markAsUncloneable is not a function`); we pin v24.3.0. Override
# the bin dir with VITE_NODE_BIN if your install differs.
#
# Usage: ./vite-keeper.sh            (run in its own terminal / background)
# Stop:  Ctrl-C, or `touch .e2e-local/stop`
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

# Serve plain HTTP so the app matches run-e2e-smoke.sh's APP_URL default.
# vite.config.ts skips the mkcert plugin entirely when this is set.
if [ "${VITE_DEV_DISABLE_HTTPS:-1}" != "0" ]; then
  export VITE_DEV_DISABLE_HTTPS=1
else
  unset VITE_DEV_DISABLE_HTTPS
fi

NODE_BIN="${VITE_NODE_BIN:-$HOME/.nvm/versions/node/v24.3.0/bin}"
if [ -x "$NODE_BIN/node" ]; then export PATH="$NODE_BIN:$PATH"; else
  echo "[vite-keeper] WARN: $NODE_BIN/node not found — using default node ($(command -v node)); Vite may fail to start." >&2
fi
echo "[vite-keeper] node $(node -v 2>/dev/null) ($(command -v node))"

mkdir -p maestro-report/logs
STOP="$ROOT/.e2e-local/stop"
n=0
while true; do
  [ -f "$STOP" ] && { echo "[vite-keeper] stop sentinel found — exiting"; break; }
  n=$((n + 1))
  echo "[vite-keeper] start #$n $(date '+%H:%M:%S')  (log: maestro-report/logs/vite.log)"
  npm run dev >> maestro-report/logs/vite.log 2>&1
  echo "[vite-keeper] vite exited (code $?) at $(date '+%H:%M:%S'); restarting in 1s"
  sleep 1
done
