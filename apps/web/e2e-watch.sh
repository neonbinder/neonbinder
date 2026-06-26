#!/bin/bash
# Block until the local workers finish a flow (polls the real /e2e queue), then
# print PASS/FAIL + where the JUnit/debug artifacts live.
# Usage: ./e2e-watch.sh <flow.yaml> [timeout_sec]   (default timeout 1800s)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
[ -f .e2e-local/env ] || { echo "✗ harness not running — start it first: ./e2e-local-up.sh" >&2; exit 1; }
# shellcheck disable=SC1091
. .e2e-local/env

flow="${1:?usage: $0 <flow.yaml> [timeout_sec]}"
case "$flow" in *.maestro/flows/*) flow=".maestro/flows/${flow#*.maestro/flows/}" ;; esac
slug="$(echo "$flow" | sed -e 's|^\.maestro/flows/||' -e 's|/|_|g' -e 's|\.yaml$||')"
deadline=$(( $(date +%s) + ${2:-1800} ))

_flow() {
  { set +x; } 2>/dev/null
  curl -fsS -X POST "$CONVEX_SITE_URL/e2e/flow" \
    -H "x-e2e-queue-secret: $E2E_QUEUE_SECRET" -H "Content-Type: application/json" \
    -d "{\"runId\":\"$E2E_RUN_ID\",\"flowPath\":\"$flow\"}"
}

last=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  resp="$(_flow 2>/dev/null)" || { sleep 3; continue; }
  st="$(printf '%s' "$resp" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    d=None
print((d or {}).get('status','') if isinstance(d,dict) else '')" 2>/dev/null)"
  [ "$st" != "$last" ] && { echo "· $(date '+%H:%M:%S') $flow: ${st:-<not queued>}"; last="$st"; }
  case "$st" in
    passed) echo "✅ PASS  $flow"; echo "   junit: maestro-report/junit/$slug.xml"; exit 0 ;;
    failed) echo "❌ FAIL  $flow"; echo "   junit: maestro-report/junit/$slug.xml"; echo "   debug: maestro-report/debug/$slug/"; exit 1 ;;
  esac
  sleep 5
done
echo "⏱ timeout waiting for $flow (status: ${last:-<none>})"; exit 2
