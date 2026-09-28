#!/usr/bin/env bash
# NEO-310: shared "did the previous run fail" check, used by every trailing
# `notify` job to decide whether a green run is a plain success (say nothing)
# or a RECOVERY (post one "recovered" message).
#
# Usage: discord-notify-recovered.sh <workflow-file> <event> <branch> [job-name-prefix]
#   workflow-file    basename under .github/workflows/, e.g. revision-gc.yml
#   event            github.event_name of the CURRENT run
#   branch           github.ref_name of the CURRENT run
#   job-name-prefix  OPTIONAL. When given, "previous" is judged by the
#                     conclusion of jobs matching this name prefix WITHIN the
#                     previous run, not the run's own overall conclusion.
#
#                     This exists for browser-deploy.yml / preprocess-deploy.yml
#                     when invoked via `uses: ./.github/workflows/*.yml` from
#                     release.yml's `push` trigger: a reusable workflow called
#                     that way does NOT get its own separate row in
#                     `gh run list --workflow browser-deploy.yml` — its jobs
#                     run nested inside release.yml's own run — so the
#                     previous invocation has to be found by looking at
#                     release.yml's run history and asking "did the job named
#                     like this lane fail", e.g.:
#                       discord-notify-recovered.sh release.yml push main "Browser service"
#                     A DIRECT workflow_dispatch of browser-deploy.yml, by
#                     contrast, DOES get its own row under browser-deploy.yml,
#                     so that path omits this argument and reads the run's own
#                     conclusion.
#
# Requires `gh` authenticated with a token that has `actions: read`, and
# GITHUB_RUN_ID set (true in any Actions job).
#
# Prints exactly one line: `recovered=true` or `recovered=false`.
set -uo pipefail

WORKFLOW_FILE="${1:?workflow file required}"
EVENT="${2:?event required}"
BRANCH="${3:?branch required}"
JOB_PREFIX="${4:-}"
CURRENT_RUN_ID="${GITHUB_RUN_ID:-0}"

RUNS_JSON="$(gh run list \
  --workflow "$WORKFLOW_FILE" \
  --event "$EVENT" \
  --branch "$BRANCH" \
  --status completed \
  --limit 2 \
  --json conclusion,databaseId 2>/dev/null)" || RUNS_JSON="[]"

# --status completed already excludes the run we're executing inside of (it
# is still in_progress from the API's point of view until this job finishes),
# but we filter the current run id out explicitly too — cheap insurance
# against any timing edge where that isn't true.
PREV_RUN_ID="$(printf '%s' "$RUNS_JSON" | jq -r --argjson cur "$CURRENT_RUN_ID" '
  [.[] | select(.databaseId != $cur)] | .[0].databaseId // ""
' 2>/dev/null)"

if [ -z "$PREV_RUN_ID" ]; then
  echo "recovered=false"
  exit 0
fi

if [ -n "$JOB_PREFIX" ]; then
  PREV_CONCLUSION="$(gh run view "$PREV_RUN_ID" --json jobs 2>/dev/null | jq -r --arg p "$JOB_PREFIX" '
    [.jobs[] | select(.name | startswith($p))] as $matched
    | if ($matched | length) == 0 then ""
      elif ($matched | any(.conclusion == "failure")) then "failure"
      else "success"
      end
  ' 2>/dev/null)"
else
  PREV_CONCLUSION="$(printf '%s' "$RUNS_JSON" | jq -r --argjson cur "$CURRENT_RUN_ID" '
    [.[] | select(.databaseId != $cur)] | .[0].conclusion // ""
  ' 2>/dev/null)"
fi

if [ "$PREV_CONCLUSION" = "failure" ]; then
  echo "recovered=true"
else
  echo "recovered=false"
fi
