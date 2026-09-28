#!/usr/bin/env bash
# NEO-310: for a matrix job, list which LEGS failed (not just that the job as
# a whole did), so a Discord message can say "GC neonbinder-preprocess prod"
# instead of just "gc". Falls back to the caller's plain job name when the
# jobs list can't be read for any reason — never blocks the notify.
#
# Usage: discord-notify-failed-legs.sh <job-name-prefix> <fallback-name>
#   job-name-prefix   the matrix job's display `name:` prefix as it appears in
#                     `gh run view --json jobs` (e.g. "GC " for
#                     "GC neonbinder-browser dev", "GC neonbinder-browser prod", ...)
#   fallback-name     what to print if the per-leg lookup fails or finds nothing
#                     (e.g. the plain job id, "gc")
#
# Prints exactly one line: `failed-legs=<comma-joined names>`.
set -uo pipefail

PREFIX="${1:?job name prefix required}"
FALLBACK="${2:?fallback name required}"

JOBS_JSON="$(gh run view "${GITHUB_RUN_ID:-}" --json jobs 2>/dev/null)" || JOBS_JSON=""

if [ -z "$JOBS_JSON" ]; then
  echo "failed-legs=$FALLBACK"
  exit 0
fi

LEGS="$(printf '%s' "$JOBS_JSON" | jq -r --arg p "$PREFIX" '
  [.jobs[] | select(.name | startswith($p)) | select(.conclusion=="failure") | .name]
  | join(", ")
' 2>/dev/null)"

if [ -z "$LEGS" ]; then
  echo "failed-legs=$FALLBACK"
else
  echo "failed-legs=$LEGS"
fi
