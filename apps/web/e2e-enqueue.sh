#!/bin/bash
# Drip flow(s) into the running local E2E queue (real NEO-49 /e2e/add endpoint).
# Usage: ./e2e-enqueue.sh .maestro/flows/set-selector/team-picker.yaml [more...]
# Re-enqueuing a flow that already ran resets it to pending (re-validate a fix).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"
[ -f .e2e-local/env ] || { echo "✗ harness not running — start it first: ./e2e-local-up.sh" >&2; exit 1; }
# shellcheck disable=SC1091
. .e2e-local/env
[ "$#" -ge 1 ] || { echo "usage: $0 <flow.yaml> [flow.yaml ...]" >&2; exit 2; }

flows=()
for f in "$@"; do
  case "$f" in *.maestro/flows/*) f=".maestro/flows/${f#*.maestro/flows/}" ;; esac
  if [[ ! "$f" =~ ^\.maestro/flows/[A-Za-z0-9._/-]+\.yaml$ ]] || [[ "$f" == *..* ]]; then
    echo "✗ invalid flow path: $f" >&2; exit 1
  fi
  [ -f "$f" ] || { echo "✗ no such flow file: $f" >&2; exit 1; }
  flows+=("$f")
done

json="$(printf '%s\n' "${flows[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")"
{ set +x; } 2>/dev/null
resp="$(curl -fsS -X POST "$CONVEX_SITE_URL/e2e/add" \
  -H "x-e2e-queue-secret: $E2E_QUEUE_SECRET" -H "Content-Type: application/json" \
  -d "{\"runId\":\"$E2E_RUN_ID\",\"flows\":$json}")" || { echo "✗ enqueue failed" >&2; exit 1; }
echo "queued (runId=$E2E_RUN_ID): $resp"
for f in "${flows[@]}"; do
  slug="$(echo "$f" | sed -e 's|^\.maestro/flows/||' -e 's|/|_|g' -e 's|\.yaml$||')"
  echo "  ↳ $f   watch: ./e2e-watch.sh $f   |  maestro-report/junit/$slug.xml"
done
