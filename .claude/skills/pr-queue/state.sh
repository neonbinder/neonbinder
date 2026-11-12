#!/usr/bin/env bash
# shellcheck disable=SC2016  # $names inside single quotes are jq variables
# pr-queue state: one JSON file shared by every checkout and worktree of the
# monorepo. It lives in the monorepo's git common dir (found from this script's
# own location, so a session launched from the workspace root and one in a
# worktree read the same file). It is never committed or pushed.
# Entries are keyed by Linear ticket (NEO-123), because a session joins before
# its PR exists.
#
# Run by the JOINING session (it writes its own entry, so no message text ever
# reaches a command the queue types):
#   state.sh join <ticket> <branch> <address> <title...>
#                                      append to the waiting line (no-op if present)
#
# Run by the QUEUE session (arguments are a ticket plus fixed words or digits):
#   state.sh path | show | owner       read the state
#   state.sh set-owner <address>       record the session running the queue
#   state.sh clear-owner               the queue session is stopping
#   state.sh position <ticket>         print the ticket's entry and place (0 = its turn)
#   state.sh call                      give the turn to the head of the line; print it
#   state.sh done <ticket> <outcome> [sha]
#                                      end the ticket's turn (or drop a waiting entry)
#                                      and log merged|passed|withdrawn|skipped;
#                                      merged takes the merge sha (hex);
#                                      an old PR-keyed entry is cleared by its number
#   state.sh move <ticket> <position>  reorder the waiting line (1 = next)
#
# Every write takes a mkdir lock, so concurrent sessions cannot lose an update.
set -euo pipefail

command -v jq >/dev/null || { echo "pr-queue: jq is required" >&2; exit 2; }

here="$(cd "$(dirname "$0")" && pwd -P)"
dir="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)/pr-queue"
file="$dir/state.json"
lock="$dir/lock"
mkdir -p "$dir"
[ -f "$file" ] || echo '{"owner":"","inFlight":null,"waiting":[],"log":[]}' >"$file"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
die() { echo "pr-queue: $*" >&2; exit 2; }

ticket_arg() { # ticket_arg <value>: upper-case it and check the Linear shape
  local k
  k="$(printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]')"
  [[ "$k" =~ ^[A-Z]+-[0-9]+$ ]] || die "not a Linear ticket (expected e.g. NEO-123)"
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

position_of() { # position_of <ticket>: the entry plus its place (0 = in flight), or null
  jq -c --arg k "$1" '
    if .inFlight.ticket == $k then .inFlight + {position: 0}
    else (.waiting | map(.ticket) | index($k)) as $i
      | if $i == null then null else .waiting[$i] + {position: ($i + 1)} end end' "$file"
}

cmd="${1:-show}"; shift || true
case "$cmd" in
  path) echo "$file" ;;
  show) jq . "$file" ;;
  owner) jq -r '.owner // ""' "$file" ;;
  set-owner)
    addr="${1:-}"
    [[ "$addr" =~ ^[[:print:]]{1,100}$ ]] || die "address must be 1-100 printable characters"
    with_lock update '.owner = $a | .ownerSince = $t' --arg a "$addr" --arg t "$(now)"
    jq -r .owner "$file" ;;
  clear-owner) with_lock update '.owner = "" | del(.ownerSince)' ;;
  join)
    [ "$#" -ge 4 ] || die "usage: join <ticket> <branch> <address> <title...>"
    k="$(ticket_arg "$1")"; branch="$2"; addr="$3"; shift 3; title="$*"
    if ! [[ "$branch" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
      die "branch must be a valid branch name of letters, digits and . _ / -"
    fi
    [[ "$addr" =~ ^[[:print:]]{1,100}$ ]] || die "address must be 1-100 printable characters"
    title_re="^[A-Za-z0-9 .,:()#_/+'-]{1,120}\$"
    [[ "$title" =~ $title_re ]] \
      || die "title must be 1-120 of letters, digits, spaces and . , : ( ) # _ / + ' -"
    with_lock update '
      if (.inFlight.ticket == $k) or any(.waiting[]; .ticket == $k) then .
      else .waiting += [{ticket: $k, branch: $b, address: $a, title: $title, joined: $t}] end' \
      --arg k "$k" --arg b "$branch" --arg a "$addr" --arg title "$title" --arg t "$(now)"
    position_of "$k" ;;
  position) position_of "$(ticket_arg "${1:-}")" ;;
  call)
    with_lock update '
      if .inFlight != null or (.waiting | length) == 0 then .
      else .inFlight = (.waiting[0] + {called: $t}) | .waiting = .waiting[1:] end' --arg t "$(now)"
    jq -c '.inFlight' "$file" ;;
  done)
    # An old entry from before tickets (keyed by PR number only) is cleared
    # with its number: done 499 <outcome>.
    if [[ "${1:-}" =~ ^#?[0-9]{1,7}$ ]]; then k=""; legacy="${1#\#}"; else k="$(ticket_arg "${1:-}")"; legacy=0; fi
    outcome="${2:-}"; sha="${3:-}"
    case "$outcome" in merged|passed|withdrawn|skipped) ;; *) die "outcome must be merged, passed, withdrawn or skipped" ;; esac
    [ -z "$sha" ] || [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "sha must be 7-40 hex characters"
    [ "$#" -le 3 ] || die "done takes no free text; give the reason in prose"
    with_lock update '
      def hit: if $k == "" then (.ticket == null and .pr == $lp) else .ticket == $k end;
      ([(.inFlight // empty), .waiting[]] | map(select(hit)) | .[0]) as $e
      | .log = ((.log + [{ticket: ($e.ticket // (if $k == "" then null else $k end)),
                          pr: ($e.pr // null), outcome: $o, sha: (if $s == "" then null else $s end), at: $t}]) | .[-50:])
      | if .inFlight != null and (.inFlight | hit) then .inFlight = null else . end
      | .waiting = [.waiting[] | select(hit | not)]' \
      --arg k "$k" --argjson lp "$legacy" --arg o "$outcome" --arg s "$sha" --arg t "$(now)"
    jq -c '{inFlight, waiting: [.waiting[] | .ticket // ("#" + (.pr | tostring))]}' "$file" ;;
  move)
    k="$(ticket_arg "${1:-}")"; pos="${2:-}"
    [[ "$pos" =~ ^[1-9][0-9]{0,2}$ ]] || die "position must be 1 or more"
    with_lock update '
      (.waiting | map(select(.ticket == $k))) as $m
      | if ($m | length) == 0 then .
        else .waiting = ([.waiting[] | select(.ticket != $k)] | .[:($p - 1)] + $m + .[($p - 1):]) end' \
      --arg k "$k" --argjson p "$pos"
    jq -c '[.waiting[] | .ticket // ("#" + (.pr | tostring))]' "$file" ;;
  *) die "unknown command" ;;
esac
