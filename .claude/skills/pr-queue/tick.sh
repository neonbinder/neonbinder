#!/usr/bin/env bash
# pr-queue heartbeat, run under a persistent Monitor by the queue session.
# Prints a line only when something needs the queue's attention:
#   TICK MERGED <ticket> <sha>     the in-flight PR merged (its session may not have said so)
#   TICK CLOSED <ticket>           the in-flight PR was closed unmerged
#   TICK IDLE <ticket> <minutes>   called that long ago and no CI run has started since
#   TICK HOLD-EXPIRED <ticket> <minutes>
#                                  the in-flight ticket has waited on Jason past the hold cap
#   TICK WAITING <n>               nothing in flight but tickets are waiting (missed call)
# The in-flight entry is followed by its PR number when set-pr has recorded one,
# else by the PR found from its branch. With no PR yet only HOLD-EXPIRED and
# IDLE can fire (the session was called but has not pushed).
# Each condition prints once until it changes. Never exits on its own.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
interval="${PR_QUEUE_INTERVAL:-60}"
idle_min="${PR_QUEUE_IDLE_MIN:-20}"
hold_min="${PR_QUEUE_HOLD_MIN:-10}"
last=""

mins_since() { # ISO-8601 UTC timestamp -> whole minutes ago (macOS or GNU date)
  local at
  at="$(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$1" +%s 2>/dev/null || date -u -d "$1" +%s)"
  echo $(( ( $(date -u +%s) - at ) / 60 ))
}

say() { [ "$1" != "$last" ] && { echo "$1"; last="$1"; }; }

while true; do
  state="$("$here/state.sh" show 2>/dev/null)" || { sleep "$interval"; continue; }
  if [ "$(jq '.inFlight != null' <<<"$state")" != true ]; then
    n="$(jq '.waiting | length' <<<"$state")"
    if [ "$n" -gt 0 ]; then say "TICK WAITING $n"; else last=""; fi
    sleep "$interval"; continue
  fi

  # A legacy entry from before tickets has only a PR number; name it #<pr>.
  ticket="$(jq -r '.inFlight | .ticket // ("#" + (.pr | tostring))' <<<"$state")"
  pr="$(jq -r '.inFlight.pr // empty' <<<"$state")"
  branch="$(jq -r '.inFlight.branch // empty' <<<"$state")"

  # Find the PR: the recorded number first, else the branch's PR.
  view=""
  if [ -n "$pr" ]; then
    view="$(gh pr view "$pr" --json state,mergeCommit,headRefName 2>/dev/null)" || { sleep "$interval"; continue; }
  elif [ -n "$branch" ]; then
    view="$(gh pr list --head "$branch" --state all --json number,state,mergeCommit,headRefName --limit 1 \
      --jq '.[0] // empty' 2>/dev/null)" || { sleep "$interval"; continue; }
  fi
  [ -n "$view" ] && [ -z "$branch" ] && branch="$(jq -r .headRefName <<<"$view")"

  case "$( [ -n "$view" ] && jq -r .state <<<"$view")" in
    MERGED) say "TICK MERGED $ticket $(jq -r '.mergeCommit.oid // "?"' <<<"$view" | cut -c1-8)" ;;
    CLOSED) say "TICK CLOSED $ticket" ;;
    *)
      hold="$(jq -r '.inFlight.holdSince // empty' <<<"$state")"
      if [ -n "$hold" ]; then
        mins="$(mins_since "$hold")"
        [ "$mins" -ge "$hold_min" ] && say "TICK HOLD-EXPIRED $ticket $mins"
        sleep "$interval"; continue
      fi
      called="$(jq -r '.inFlight.called // empty' <<<"$state")"
      [ -z "$called" ] && { sleep "$interval"; continue; }
      latest=""
      if [ -n "$branch" ]; then
        latest="$(gh run list --branch "$branch" --limit 1 --json createdAt --jq '.[0].createdAt // ""' 2>/dev/null)" \
          || { sleep "$interval"; continue; }
      fi
      if [ -z "$latest" ] || [[ "$latest" < "$called" ]]; then
        mins="$(mins_since "$called")"
        [ "$mins" -ge "$idle_min" ] && say "TICK IDLE $ticket $mins"
      else
        last=""
      fi ;;
  esac
  sleep "$interval"
done
