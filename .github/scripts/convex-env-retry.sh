#!/usr/bin/env bash
# Run a Convex CLI command with retries (NEO-341).
#
# Several CI jobs write env vars to the same Convex preview concurrently, and
# Convex answers a colliding write with "503 ... OptimisticConcurrencyControlFailure".
# npx can also die on a torn cache entry ("Cannot find module 'prettier'",
# "./buffer-util"), typically two npx processes installing the same package into
# the same ~/.npm/_npx/<hash> at once. npx treats an existing entry as installed,
# so a plain retry fails identically: on "Cannot find module" this script deletes
# the _npx/<hash> dir that holds convex, so the next attempt reinstalls cleanly.
#
# Jobs that background `npx convex logs` must first run the sequential warm-up
# (`convex-env-retry.sh --version`), so nothing installs concurrently. This is
# the one place the CLI pin lives.
#
# Usage: convex-env-retry.sh env set NAME VALUE --deployment X
#        convex-env-retry.sh env remove NAME --deployment X
#        convex-env-retry.sh --version            (warm-up, no deployment)
# Arguments are passed to `npx --yes convex@<pin>`. Override the runner for
# tests with CONVEX_RETRY_CMD (a command prefix, word-split) and the backoff
# with CONVEX_RETRY_DELAYS (space-separated seconds).
#
# Exit: 0 on success; otherwise the last attempt's exit code. For `env remove`,
# a "not set" answer is deterministic, so it is returned at once, unretried,
# and callers keep their existing `|| echo "not set"` handling.
set -uo pipefail

CONVEX_PIN="convex@1.39.1"
read -r -a runner <<< "${CONVEX_RETRY_CMD:-npx --yes $CONVEX_PIN}"
read -r -a delays <<< "${CONVEX_RETRY_DELAYS:-2 5 10}"
max=$((${#delays[@]} + 1))

out=$(mktemp)
trap 'rm -f "$out"' EXIT

attempt=1
while :; do
  rc=0
  "${runner[@]}" "$@" >"$out" 2>&1 || rc=$?
  cat "$out"
  [ "$rc" -eq 0 ] && exit 0

  if [ "${1:-}" = "env" ] && [ "${2:-}" = "remove" ] \
     && grep -qiE 'not (set|found)|does not exist|no such' "$out"; then
    exit "$rc"
  fi
  if grep -q 'Cannot find module' "$out"; then
    # Torn npx entry: remove it (CONVEX_RETRY_NPX_CACHE overrides the cache dir for tests).
    cache="${CONVEX_RETRY_NPX_CACHE:-$(npm config get cache 2>/dev/null)/_npx}"
    for dir in "$cache"/*/node_modules/convex; do
      [ -d "$dir" ] || continue
      entry="${dir%/node_modules/convex}"
      echo "::warning::removing torn npx cache entry $entry" >&2
      rm -rf "$entry"
    done
  fi
  if [ "$attempt" -ge "$max" ]; then
    echo "::error::convex $* failed after $attempt attempts (last exit $rc)" >&2
    exit "$rc"
  fi
  delay="${delays[$((attempt - 1))]}"
  echo "::warning::convex ${1:-} ${2:-} failed (attempt $attempt/$max, exit $rc); retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
