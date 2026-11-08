#!/usr/bin/env bash
# pr-queue heartbeat, run under a persistent Monitor by the queue session.
# Prints a line only when something needs the queue's attention:
#   TICK MERGED <pr> <sha>     the in-flight PR merged (its session may not have said so)
#   TICK CLOSED <pr>           the in-flight PR was closed unmerged
#   TICK IDLE <pr> <minutes>   called that long ago and no CI run has started since
#   TICK WAITING <n>           nothing in flight but PRs are waiting (missed call)
# Each condition prints once until it changes. Never exits on its own.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
interval="${PR_QUEUE_INTERVAL:-300}"
idle_min="${PR_QUEUE_IDLE_MIN:-20}"
last=""

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
        called="$(jq -r '.inFlight.called' <<<"$state")"
        branch="$(jq -r .headRefName <<<"$view")"
        latest="$(gh run list --branch "$branch" --limit 1 --json createdAt --jq '.[0].createdAt // ""' 2>/dev/null)"
        if [ -z "$latest" ] || [[ "$latest" < "$called" ]]; then
          mins=$(( ( $(date -u +%s) - $(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$called" +%s 2>/dev/null || date -u -d "$called" +%s) ) / 60 ))
          [ "$mins" -ge "$idle_min" ] && say "TICK IDLE $pr $mins"
        else
          last=""
        fi ;;
    esac
  fi
  sleep "$interval"
done
