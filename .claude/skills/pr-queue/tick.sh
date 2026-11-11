#!/usr/bin/env bash
# pr-queue heartbeat, run under a persistent Monitor by the queue session.
# Prints a line only when something needs the queue's attention:
#   TICK MERGED <ticket> <sha>     the in-flight PR merged (its session may not have said so)
#   TICK CLOSED <ticket>           the in-flight PR was closed unmerged
#   TICK MISMATCH <ticket>         the recorded PR is a fork's or is not on the entry's branch
#   TICK IDLE <ticket> <minutes>   called that long ago and no CI run has started since
#   TICK HOLD-EXPIRED <ticket> <minutes>
#                                  the in-flight ticket has waited on Jason past the hold cap
#   TICK WAITING <n>               nothing in flight but tickets are waiting (missed call)
# The in-flight entry is followed by its PR number when set-pr has recorded one,
# else by this repo's PR on its branch that is open or was opened after the
# call. With no PR yet only HOLD-EXPIRED and IDLE can fire (the session was
# called but has not pushed). Only this repo's runs count, never a fork's.
# Each condition prints once until it changes. Never exits on its own.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
interval="${PR_QUEUE_INTERVAL:-60}"
idle_min="${PR_QUEUE_IDLE_MIN:-20}"
hold_min="${PR_QUEUE_HOLD_MIN:-10}"
last=""
repo=""

mins_since() { # ISO-8601 UTC timestamp -> whole minutes ago (macOS or GNU date)
  local at
  at="$(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$1" +%s 2>/dev/null || date -u -d "$1" +%s)"
  echo $(( ( $(date -u +%s) - at ) / 60 ))
}

say() { [ "$1" != "$last" ] && { echo "$1"; last="$1"; }; }

# pick_branch_pr <called>: from `gh pr list` JSON on stdin, this repo's PR that
# is open or was created at or after the call; empty when there is none.
pick_branch_pr() {
  jq -c --arg c "$1" '[.[] | select((.isCrossRepository | not) and (.state == "OPEN" or .createdAt >= $c))] | .[0] // empty'
}

# latest_run <repo>: from the actions/runs JSON on stdin, the newest run's
# createdAt among runs from this repo (not a fork); empty when there is none.
latest_run() {
  jq -r --arg r "$1" '[.workflow_runs[] | select(.head_repository.full_name == $r)] | (.[0].created_at // "")'
}

# PR_QUEUE_SELFTEST=1 runs the jq filters on canned JSON and exits.
if [ "${PR_QUEUE_SELFTEST:-}" = 1 ]; then
  prs='[{"number":9,"state":"OPEN","isCrossRepository":true,"createdAt":"2026-11-11T12:00:00Z"},
        {"number":8,"state":"MERGED","isCrossRepository":false,"createdAt":"2026-11-01T00:00:00Z"},
        {"number":7,"state":"MERGED","isCrossRepository":false,"createdAt":"2026-11-11T11:00:00Z"}]'
  echo "branch PR, call at 10:00 -> $(pick_branch_pr 2026-11-11T10:00:00Z <<<"$prs")"
  echo "branch PR, call at 12:00 -> [$(pick_branch_pr 2026-11-11T12:00:00Z <<<"$prs")]"
  runs='{"workflow_runs":[{"created_at":"2026-11-11T12:30:00Z","head_repository":{"full_name":"someone/fork"}},
         {"created_at":"2026-11-11T12:10:00Z","head_repository":{"full_name":"org/repo"}}]}'
  echo "latest run in org/repo -> $(latest_run org/repo <<<"$runs")"
  echo "latest run, only forks -> [$(latest_run org/other <<<"$runs")]"
  exit 0
fi

while true; do
  [ -n "$repo" ] || repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" \
    || { sleep "$interval"; continue; }
  state="$("$here/state.sh" show 2>/dev/null)" || { sleep "$interval"; continue; }
  if [ "$(jq '.inFlight != null' <<<"$state")" != true ]; then
    n="$(jq '.waiting | length' <<<"$state")"
    if [ "$n" -gt 0 ]; then say "TICK WAITING $n"; else last=""; fi
    sleep "$interval"; continue
  fi

  # An old entry from before tickets has only a PR number; name it #<pr>.
  ticket="$(jq -r '.inFlight | .ticket // ("#" + (.pr | tostring))' <<<"$state")"
  pr="$(jq -r '.inFlight.pr // empty' <<<"$state")"
  branch="$(jq -r '.inFlight.branch // empty' <<<"$state")"
  called="$(jq -r '.inFlight.called // empty' <<<"$state")"

  # Find the PR: the recorded number first, else this repo's PR on the branch.
  view=""
  if [ -n "$pr" ]; then
    view="$(gh pr view "$pr" --json state,mergeCommit,headRefName,isCrossRepository 2>/dev/null)" \
      || { sleep "$interval"; continue; }
    if [ "$(jq -r .isCrossRepository <<<"$view")" != false ] \
      || { [ -n "$branch" ] && [ "$(jq -r .headRefName <<<"$view")" != "$branch" ]; }; then
      say "TICK MISMATCH $ticket"; sleep "$interval"; continue
    fi
  elif [ -n "$branch" ] && [ -n "$called" ]; then
    list="$(gh pr list --head "$branch" --state all --limit 20 \
      --json number,state,mergeCommit,headRefName,isCrossRepository,createdAt 2>/dev/null)" \
      || { sleep "$interval"; continue; }
    view="$(pick_branch_pr "$called" <<<"$list")"
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
      [ -z "$called" ] && { sleep "$interval"; continue; }
      latest=""
      if [ -n "$branch" ]; then
        runs="$(gh api -X GET 'repos/{owner}/{repo}/actions/runs' -f branch="$branch" -F per_page=20 2>/dev/null)" \
          || { sleep "$interval"; continue; }
        latest="$(latest_run "$repo" <<<"$runs")"
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
