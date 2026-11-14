#!/usr/bin/env bash
# NEO-546 S5: is this PR in the merge queue right now? Used by preview-cleanup's
# `gate` job, because a `dequeued` event can be stale by the time the job runs
# (the author re-enqueued at once), and tearing previews down under a live
# queue run would break it.
#
# Prints exactly one line: entry=present | absent | unknown
#   present  GraphQL says mergeQueueEntry is non-null
#   absent   GraphQL answered and mergeQueueEntry is null
#   unknown  any API error, an error object in the answer, or an unreadable body
#            (the caller treats unknown like present: a leaked preview is
#            reclaimed when the PR closes, a torn-down live one is a failed run)
#
# Environment: GITHUB_REPOSITORY (owner/name), PR (number), GH_TOKEN.
set -uo pipefail

REPO="${GITHUB_REPOSITORY:-}"
PR="${PR:-}"
owner="${REPO%%/*}"
name="${REPO#*/}"

if [ -z "$owner" ] || [ -z "$name" ] || [ "$owner" = "$REPO" ] || ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "entry=unknown"
  exit 0
fi

# shellcheck disable=SC2016  # GraphQL variables, not shell
query='query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){mergeQueueEntry{id}}}}'
if ! body=$(gh api graphql -f query="$query" -F owner="$owner" -F name="$name" -F pr="$PR" 2>/dev/null) || [ -z "$body" ]; then
  echo "entry=unknown"
  exit 0
fi

state=$(printf '%s' "$body" | jq -r '
  if (.errors // null) != null then "unknown"
  elif (.data.repository.pullRequest // null) == null then "unknown"
  elif (.data.repository.pullRequest.mergeQueueEntry // null) == null then "absent"
  else "present" end' 2>/dev/null) || state="unknown"

case "$state" in
  present|absent) echo "entry=$state" ;;
  *) echo "entry=unknown" ;;
esac
