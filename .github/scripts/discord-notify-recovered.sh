#!/usr/bin/env bash
# NEO-310: shared "did the previous run fail" check, used by every trailing
# `notify` job to decide whether a green run is a plain success (say nothing)
# or a RECOVERY (post one "recovered" message).
#
# Usage: discord-notify-recovered.sh <workflow-file> <event> <branch>
#   workflow-file  basename under .github/workflows/, e.g. revision-gc.yml
#   event          github.event_name of the CURRENT run
#   branch         github.ref_name of the CURRENT run
#
# Requires `gh` authenticated with a token that has `actions: read`, and
# GITHUB_RUN_ID set (true in any Actions job).
#
# Prints exactly one line: `recovered=true` or `recovered=false`.
#
# Every caller of this script gets its own row in
# `gh run list --workflow <workflow-file>`: the scheduled workflows
# (revision-gc.yml, revision-image-check.yml, secret-version-gc.yml,
# refresh-flow-timings.yml) trigger themselves directly, release.yml
# triggers itself directly on `push`, and browser-deploy.yml /
# preprocess-deploy.yml only call this script from their `notify` job when
# THEY were the direct `workflow_dispatch` target (see the security review
# note in those files, NEO-310 N4) — never when invoked via release.yml's
# `uses:` call, where release.yml's OWN `notify` job covers the lane instead.
set -uo pipefail

WORKFLOW_FILE="${1:?workflow file required}"
EVENT="${2:?event required}"
BRANCH="${3:?branch required}"
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
PREV_CONCLUSION="$(printf '%s' "$RUNS_JSON" | jq -r --argjson cur "$CURRENT_RUN_ID" '
  [.[] | select(.databaseId != $cur)] | .[0].conclusion // ""
' 2>/dev/null)"

if [ "$PREV_CONCLUSION" = "failure" ]; then
  echo "recovered=true"
else
  echo "recovered=false"
fi
