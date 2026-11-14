#!/usr/bin/env bash
# NEO-546 S5: cancel a PR's merge-queue runs that are still going after the PR
# was dequeued, so nothing rebuilds a preview after the teardown.
#
# Only runs CREATED BEFORE this workflow run are touched. A PR that is
# re-enqueued straight away gets a new merge group whose runs start after the
# dequeue event; those must survive. If this run's own created_at cannot be
# read, nothing is cancelled.
#
# Prints `cancelled=<run ids, space separated>` (possibly empty) and exits 0;
# cancelling is best effort. Exits 1 only when it could not decide.
#
# Environment: GITHUB_REPOSITORY, GITHUB_RUN_ID, PR (number), GH_TOKEN.
set -uo pipefail

REPO="${GITHUB_REPOSITORY:-}"
RUN_ID="${GITHUB_RUN_ID:-}"
PR="${PR:-}"

if ! [[ "$PR" =~ ^[0-9]+$ ]] || ! [[ "$RUN_ID" =~ ^[0-9]+$ ]] || [ -z "$REPO" ]; then
  echo "::error::cancel-queue-runs: PR, GITHUB_RUN_ID and GITHUB_REPOSITORY are required." >&2
  exit 1
fi

if ! mine=$(gh api "repos/${REPO}/actions/runs/${RUN_ID}" --jq '.created_at' 2>/dev/null) || [ -z "$mine" ] || [ "$mine" = "null" ]; then
  echo "::warning::cancel-queue-runs: could not read this run's created_at; cancelling nothing." >&2
  echo "cancelled="
  exit 1
fi

cancelled=""
for status in queued in_progress; do
  if ! body=$(gh api "repos/${REPO}/actions/runs?event=merge_group&status=${status}&per_page=100" 2>/dev/null); then
    echo "::warning::cancel-queue-runs: could not list ${status} runs." >&2
    continue
  fi
  ids=$(printf '%s' "$body" | jq -r --arg pr "$PR" --arg mine "$mine" '
    .workflow_runs[]?
    | select((.head_branch // "") | test("^gh-readonly-queue/.+/pr-" + $pr + "-[0-9a-f]+$"))
    | select(.created_at < $mine)
    | .id' 2>/dev/null) || ids=""
  for rid in $ids; do
    echo "Cancelling merge-queue run $rid" >&2
    gh run cancel "$rid" --repo "$REPO" >/dev/null 2>&1 || echo "::warning::could not cancel run $rid" >&2
    cancelled="${cancelled:+$cancelled }$rid"
  done
done
echo "cancelled=$cancelled"
