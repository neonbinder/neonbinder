#!/bin/bash
# ─── Vite auto-restart keeper ────────────────────────────────────────────────
# Local Vite SIGSEGVs intermittently (mkcert plugin's bundled undici + Node), so
# E2E runs lose the app mid-flow. This keeps an app alive at https://localhost:3000
# by restarting Vite whenever it exits.
#
# Node: the default `node` is too old for the mkcert/undici plugin
# (`webidl.util.markAsUncloneable is not a function`); we pin v24.3.0. Override the
# bin dir with VITE_NODE_BIN if your install differs.
#
# Usage: ./vite-keeper.sh            (run in its own terminal / background)
# Stop:  Ctrl-C, or `touch .e2e-local/stop`
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

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
