#!/usr/bin/env bash
# pr-queue heartbeat, run under a persistent Monitor by the queue session.
# Prints a line only when something needs the queue's attention:
#   TICK MERGED <pr> <sha>     the in-flight PR merged (its session may not have said so)
#   TICK CLOSED <pr>           the in-flight PR was closed unmerged
#   TICK IDLE <pr> <minutes>   called that long ago and no CI run has started since
#   TICK HOLD-EXPIRED <pr> <minutes>
#                              the in-flight PR has waited on Jason past the hold cap
#   TICK WAITING <n>           nothing in flight but PRs are waiting (missed call)
# Each condition prints once until it changes. Never exits on its own.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
interval="${PR_QUEUE_INTERVAL:-60}"
idle_min="${PR_QUEUE_IDLE_MIN:-20}"
hold_min="${PR_QUEUE_HOLD_MIN:-10}"
last=""

mins_since() { # ISO-8601 UTC timestamp -> whole minutes ago (macOS or GNU date)
  local then
  then="$(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$1" +%s 2>/dev/null || date -u -d "$1" +%s)"
  echo $(( ( $(date -u +%s) - then ) / 60 ))
}

say() { [ "$1" != "$last" ] && { echo "$1"; last="$1"; }; }

while true; do
  state="$("$here/state.sh" show 2>/dev/null)" || { sleep "$interval"; continue; }
  pr="$(jq -r '.inFlight.pr // empty' <<<"$state")"
  if [ -z "$pr" ]; then
    n="$(jq '.waiting | length' <<<"$state")"
    if [ "$n" -gt 0 ]; then say "TICK WAITING $n"; else last=""; fi
  else
    view="$(gh pr view "$pr" --json state,mergeCommit,headRefName 2>/dev/null)" || { sleep "$interval"; continue; }
    case "$(jq -r .state <<<"$view")" in
      MERGED) say "TICK MERGED $pr $(jq -r '.mergeCommit.oid // "?"' <<<"$view" | cut -c1-8)" ;;
      CLOSED) say "TICK CLOSED $pr" ;;
      *)
        hold="$(jq -r '.inFlight.holdSince // empty' <<<"$state")"
        if [ -n "$hold" ]; then
          mins="$(mins_since "$hold")"
          [ "$mins" -ge "$hold_min" ] && say "TICK HOLD-EXPIRED $pr $mins"
          sleep "$interval"; continue
        fi
        called="$(jq -r '.inFlight.called' <<<"$state")"
        branch="$(jq -r .headRefName <<<"$view")"
        latest="$(gh run list --branch "$branch" --limit 1 --json createdAt --jq '.[0].createdAt // ""' 2>/dev/null)"
        if [ -z "$latest" ] || [[ "$latest" < "$called" ]]; then
          mins="$(mins_since "$called")"
          [ "$mins" -ge "$idle_min" ] && say "TICK IDLE $pr $mins"
        else
          last=""
        fi ;;
    esac
  fi
  sleep "$interval"
done
