#!/usr/bin/env bash
# NEO-546: decide what to do when GitHub's merge queue acts on a PR, from the
# `reason` on the `pull_request: dequeued` event (or the plain `closed` event).
#
# Prints key=value lines on stdout (append them to $GITHUB_OUTPUT):
#   teardown  "true" -> tear down this PR's previews (Cloud Run tags, Convex preview)
#   notify    "true" -> post to Discord
#   reason    the normalised reason, [A-Z0-9_] only, at most 40 characters
#   detail    one human line for the Discord message
#
# Policy:
#   closed                         teardown, quiet (what preview-cleanup always did)
#   dequeued: SUCCESS, MERGED,
#             ALREADY_MERGED       neither: the PR's `closed` event tears down
#   dequeued: MANUAL               teardown, quiet (someone pulled it on purpose)
#   dequeued: CI_FAILURE,
#             CI_TIMEOUT           teardown + notify (a failed check or a timeout)
#   dequeued: anything else        teardown + notify (merge conflict, branch
#                                  protections, queue cleared, an empty or new
#                                  reason...). An unfamiliar reason is worth a
#                                  ping; silence is the worse mistake.
#   any other action               neither
#
# Environment: EVENT_ACTION (github.event.action), REASON (github.event.reason).
# Never prints a secret and never reads the network.
set -uo pipefail

action="${EVENT_ACTION:-}"
# The reason comes from an event payload: keep only what we expect to find in a
# GITHUB_OUTPUT line and in a Discord message.
reason=$(printf '%s' "${REASON:-}" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z0-9_' | cut -c1-40)

emit() {
  # emit <teardown> <notify> <detail>
  printf 'teardown=%s\nnotify=%s\nreason=%s\ndetail=%s\n' "$1" "$2" "$reason" "$3"
}

case "$action" in
  closed)
    emit true false "PR closed"
    ;;
  dequeued)
    case "$reason" in
      SUCCESS|MERGED|ALREADY_MERGED)
        emit false false "merged through the queue"
        ;;
      MANUAL)
        emit true false "removed from the queue by hand"
        ;;
      CI_FAILURE)
        emit true true "a required check failed in the merge queue run"
        ;;
      CI_TIMEOUT)
        emit true true "the merge queue run timed out"
        ;;
      "")
        emit true true "removed from the merge queue (no reason given)"
        ;;
      *)
        emit true true "removed from the merge queue (reason: ${reason})"
        ;;
    esac
    ;;
  *)
    emit false false "no action for '${action:-empty}'"
    ;;
esac
