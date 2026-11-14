#!/usr/bin/env bash
# Fake gh for queue.test.sh. Serves fixtures from $FIX; graphql.json.N (N = the
# call number, from 1) overrides graphql.json so a scenario can change by tick.
set -uo pipefail
case "$1 ${2:-}" in
  "repo view") echo "acme/widgets" ;;
  "api graphql")
    n=$(cat "$FIX/.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FIX/.n"
    if [ -f "$FIX/graphql.json.$n" ]; then cat "$FIX/graphql.json.$n"; else cat "$FIX/graphql.json"; fi ;;
  "run list") cat "$FIX/runs.json" ;;
  "run view") cat "$FIX/run-$3.json" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 1 ;;
esac
