#!/usr/bin/env bash
# shellcheck disable=SC2016  # $names inside single quotes are jq variables
# pr-queue state: one JSON file shared by every checkout and worktree of this
# repo (it lives in the git common dir, so it is never committed or pushed).
# Entries are keyed by Linear ticket (NEO-123), because a session joins before
# its PR exists. The PR number is added with set-pr once the PR is created.
#
#   state.sh path                      print the state file path
#   state.sh show                      print the whole state
#   state.sh owner                     print the queue session's address ("" if none)
#   state.sh set-owner <address>       record the session running the queue
#   state.sh clear-owner               the queue session is stopping
#   state.sh join <ticket> <branch> <address> <title...>
#                                      append to the waiting line (no-op if present)
#   state.sh set-pr <ticket> <pr>      record the ticket's PR number once it exists
#   state.sh call                      move the head of the line in flight; print it
#   state.sh done <ticket> <outcome> [note...]
#                                      clear the in-flight ticket (or drop a waiting one)
#                                      and log the outcome (merged|out|withdrawn|skipped);
#                                      a legacy PR-keyed entry is cleared by its number
#   state.sh move <ticket> <position>  reorder the waiting line (1 = next)
#   state.sh hold <ticket> <reason...> the in-flight ticket waits on Jason (starts the hold clock)
#   state.sh resume <ticket>           Jason answered; stop the hold clock
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

ticket_arg() { # ticket_arg <value>: upper-case it and check the Linear shape
  local k
  k="$(printf '%s' "${1:?ticket}" | tr '[:lower:]' '[:upper:]')"
  [[ "$k" =~ ^[A-Z]+-[0-9]+$ ]] || { echo "pr-queue: '$1' is not a Linear ticket (e.g. NEO-123)" >&2; exit 2; }
  echo "$k"
}

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
    k="$(ticket_arg "${1:-}")"; branch="${2:?branch}"; addr="${3:?address}"; shift 3
    with_lock update '
      if (.inFlight.ticket == $k) or any(.waiting[]; .ticket == $k) then .
      else .waiting += [{ticket: $k, branch: $b, address: $a, title: $title, joined: $t}] end' \
      --arg k "$k" --arg b "$branch" --arg a "$addr" --arg title "$*" --arg t "$(now)"
    jq -c --arg k "$k" '
      if .inFlight.ticket == $k then {ticket: $k, position: 0}
      else {ticket: $k, position: ((.waiting | map(.ticket) | index($k)) + 1)} end' "$file" ;;
  set-pr)
    k="$(ticket_arg "${1:-}")"; pr="${2:?pr}"; pr="${pr#\#}"
    [[ "$pr" =~ ^[0-9]+$ ]] || { echo "pr-queue: '$2' is not a PR number" >&2; exit 2; }
    with_lock update '
      (if .inFlight.ticket == $k then .inFlight.pr = $pr else . end)
      | .waiting = [.waiting[] | if .ticket == $k then .pr = $pr else . end]' \
      --arg k "$k" --argjson pr "$pr"
    jq -c --arg k "$k" '[(.inFlight // empty), .waiting[]] | map(select(.ticket == $k)) | .[0] // null' "$file" ;;
  call)
    with_lock update '
      if .inFlight != null or (.waiting | length) == 0 then .
      else .inFlight = (.waiting[0] + {called: $t}) | .waiting = .waiting[1:] end' --arg t "$(now)"
    jq -c '.inFlight' "$file" ;;
  done)
    # A legacy entry from before tickets (keyed by PR number only) is cleared
    # with its number: done 499 <outcome>.
    if [[ "${1:-}" =~ ^#?[0-9]+$ ]]; then k=""; legacy="${1#\#}"; else k="$(ticket_arg "${1:-}")"; legacy=0; fi
    outcome="${2:?outcome}"; shift 2
    with_lock update '
      def hit: if $k == "" then (.ticket == null and .pr == $lp) else .ticket == $k end;
      ([(.inFlight // empty), .waiting[]] | map(select(hit)) | .[0]) as $e
      | .log = ((.log + [{ticket: ($e.ticket // (if $k == "" then null else $k end)), pr: ($e.pr // null), outcome: $o, note: $n, at: $t}]) | .[-50:])
      | if .inFlight != null and (.inFlight | hit) then .inFlight = null else . end
      | .waiting = [.waiting[] | select(hit | not)]' \
      --arg k "$k" --argjson lp "$legacy" --arg o "$outcome" --arg n "$*" --arg t "$(now)"
    jq -c '{inFlight, waiting: [.waiting[] | .ticket // ("#" + (.pr | tostring))]}' "$file" ;;
  move)
    k="$(ticket_arg "${1:-}")"; pos="${2:?position}"
    [[ "$pos" =~ ^[1-9][0-9]*$ ]] || { echo "pr-queue: position must be 1 or more" >&2; exit 2; }
    with_lock update '
      (.waiting | map(select(.ticket == $k))) as $m
      | if ($m | length) == 0 then .
        else .waiting = ([.waiting[] | select(.ticket != $k)] | .[:($p - 1)] + $m + .[($p - 1):]) end' \
      --arg k "$k" --argjson p "$pos"
    jq -c '[.waiting[] | .ticket // ("#" + (.pr | tostring))]' "$file" ;;
  hold)
    k="$(ticket_arg "${1:-}")"; shift
    with_lock update 'if .inFlight.ticket == $k then .inFlight += {holdSince: $t, holdReason: $r} else . end' \
      --arg k "$k" --arg t "$(now)" --arg r "$*"
    jq -c '.inFlight' "$file" ;;
  resume)
    k="$(ticket_arg "${1:-}")"
    with_lock update 'if .inFlight.ticket == $k then .inFlight |= del(.holdSince, .holdReason) else . end' \
      --arg k "$k"
    jq -c '.inFlight' "$file" ;;
  *) echo "pr-queue: unknown command '$cmd'" >&2; exit 2 ;;
esac
