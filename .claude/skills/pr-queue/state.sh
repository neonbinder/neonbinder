#!/usr/bin/env bash
# pr-queue state: one JSON file shared by every checkout and worktree of this
# repo (it lives in the git common dir, so it is never committed or pushed).
#
#   state.sh path                      print the state file path
#   state.sh show                      print the whole state
#   state.sh owner                     print the queue session's address ("" if none)
#   state.sh set-owner <address>       record the session running the queue
#   state.sh clear-owner               the queue session is stopping
#   state.sh join <pr> <ticket> <address> <title...>
#                                      append to the waiting line (no-op if present)
#   state.sh call                      move the head of the line in flight; print it
#   state.sh done <pr> <outcome> [note...]
#                                      clear the in-flight PR (or drop a waiting one)
#                                      and log the outcome (merged|out|withdrawn|skipped)
#   state.sh move <pr> <position>      reorder the waiting line (1 = next)
#   state.sh hold <pr> <reason...>     the in-flight PR waits on Jason (starts the hold clock)
#   state.sh resume <pr>               Jason answered; stop the hold clock
#
# Every write takes a mkdir lock, so concurrent sessions cannot lose an update.
set -euo pipefail

command -v jq >/dev/null || { echo "pr-queue: jq is required" >&2; exit 2; }

dir="$(git rev-parse --path-format=absolute --git-common-dir)/pr-queue"
file="$dir/state.json"
lock="$dir/lock"
mkdir -p "$dir"
[ -f "$file" ] || echo '{"owner":"","inFlight":null,"waiting":[],"log":[]}' >"$file"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

with_lock() {
  local tries=0
  until mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 50 ]; then
      echo "pr-queue: lock held for 10s ($lock); remove it if no session is writing" >&2
      exit 3
    fi
    sleep 0.2
  done
  trap 'rmdir "$lock" 2>/dev/null || true' EXIT
  "$@"
}

update() { # update <jq filter> [jq args...]
  local filter="$1"; shift
  local tmp="$file.tmp.$$"
  jq "$@" "$filter" "$file" >"$tmp" && mv "$tmp" "$file"
}

cmd="${1:-show}"; shift || true
case "$cmd" in
  path) echo "$file" ;;
  show) jq . "$file" ;;
  owner) jq -r '.owner // ""' "$file" ;;
  set-owner)
    with_lock update '.owner = $a | .ownerSince = $t' --arg a "${1:?address}" --arg t "$(now)"
    jq -r .owner "$file" ;;
  clear-owner) with_lock update '.owner = "" | del(.ownerSince)' ;;
  join)
    pr="${1:?pr}"; ticket="${2:?ticket}"; addr="${3:?address}"; shift 3
    with_lock update '
      if (.inFlight.pr == $pr) or any(.waiting[]; .pr == $pr) then .
      else .waiting += [{pr: $pr, ticket: $k, address: $a, title: $title, joined: $t}] end' \
      --argjson pr "$pr" --arg k "$ticket" --arg a "$addr" --arg title "$*" --arg t "$(now)"
    jq -c --argjson pr "$pr" '
      if .inFlight.pr == $pr then {pr: $pr, position: 0}
      else {pr: $pr, position: ((.waiting | map(.pr) | index($pr)) + 1)} end' "$file" ;;
  call)
    with_lock update '
      if .inFlight != null or (.waiting | length) == 0 then .
      else .inFlight = (.waiting[0] + {called: $t}) | .waiting = .waiting[1:] end' --arg t "$(now)"
    jq -c '.inFlight' "$file" ;;
  done)
    pr="${1:?pr}"; outcome="${2:?outcome}"; shift 2
    with_lock update '
      .log = ((.log + [{pr: $pr, outcome: $o, note: $n, at: $t}]) | .[-50:])
      | if .inFlight.pr == $pr then .inFlight = null else . end
      | .waiting = [.waiting[] | select(.pr != $pr)]' \
      --argjson pr "$pr" --arg o "$outcome" --arg n "$*" --arg t "$(now)"
    jq -c '{inFlight, waiting: [.waiting[].pr]}' "$file" ;;
  move)
    pr="${1:?pr}"; pos="${2:?position}"
    with_lock update '
      (.waiting | map(select(.pr == $pr))) as $m
      | if ($m | length) == 0 then .
        else .waiting = ([.waiting[] | select(.pr != $pr)] | .[:($p - 1)] + $m + .[($p - 1):]) end' \
      --argjson pr "$pr" --argjson p "$pos"
    jq -c '[.waiting[].pr]' "$file" ;;
  hold)
    pr="${1:?pr}"; shift
    with_lock update 'if .inFlight.pr == $pr then .inFlight += {holdSince: $t, holdReason: $r} else . end' \
      --argjson pr "$pr" --arg t "$(now)" --arg r "$*"
    jq -c '.inFlight' "$file" ;;
  resume)
    pr="${1:?pr}"
    with_lock update 'if .inFlight.pr == $pr then .inFlight |= del(.holdSince, .holdReason) else . end' \
      --argjson pr "$pr"
    jq -c '.inFlight' "$file" ;;
  *) echo "pr-queue: unknown command '$cmd'" >&2; exit 2 ;;
esac
