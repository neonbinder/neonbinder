#!/usr/bin/env bash
# NEO-546: decide whether a CI run is CHEAP or FULL, and resolve which PR,
# commit and branch it is about. Called by the `changes` job of
# pr-pipeline.yml and by the scope jobs of browser.yml and preprocess.yml, so
# all three agree.
#
# Cheap mode (lint, typecheck, unit, hygiene only) is chosen only when ALL of
# these hold:
#   1. the event is pull_request,
#   2. repo variable MERGE_QUEUE is exactly "true",
#   3. the LIVE branch rules for main contain a `merge_queue` rule AND a
#      `required_status_checks` rule that requires the context `CI Gate`
#      pinned to the GitHub Actions app (integration id 15368). Both are read
#      from the API now, never from the event payload. Without the pinned
#      gate, the queue would merge on whatever else is required, and cheap
#      checks alone could reach main (NEO-546 S2).
#   4. the PR carries no `run-e2e` label (read live, so "label it, re-run" works).
# Anything else is FULL: merge_group and push/dispatch events, an unset
# variable, a missing rule, the label, and EVERY API or parse error. The
# script fails closed to full, so a PR can never reach main on cheap checks
# unless GitHub's merge queue is verifiably the thing that will run the rest.
#
# Environment:
#   EVENT_NAME           github.event_name
#   GITHUB_REPOSITORY    owner/name
#   GITHUB_REF           github.ref (merge_group: refs/heads/gh-readonly-queue/<base>/pr-<N>-<sha>)
#   GITHUB_SHA           github.sha
#   GITHUB_REF_NAME      github.ref_name (other events)
#   MERGE_QUEUE          vars.MERGE_QUEUE
#   PR_NUMBER            github.event.pull_request.number (pull_request)
#   PR_HEAD_SHA          github.event.pull_request.head.sha (pull_request)
#   PR_HEAD_REF          github.event.pull_request.head.ref (pull_request)
#   GH_TOKEN             token for `gh api`
#
# Prints key=value lines on stdout (append them to $GITHUB_OUTPUT):
#   full       "true" | "false"
#   pr         PR number, or empty when the run has no PR (dispatch)
#   sha        the commit under test. pull_request: the PR head. merge_group:
#              the queue's merge commit. This is what a pr-<N> preview revision
#              is labelled with.
#   head_sha   the PR's head commit (what the Deployment record is keyed on)
#   head_ref   the PR's head branch (what names the Convex preview)
#   reason     why this mode, for the log
# Human-readable notes go to stderr.
#
# Exit status: 0, except on a merge_group run that must not proceed:
#   * the queue ref cannot be parsed, or the PR cannot be read (it cannot name
#     its PR, so it fails loudly instead of building previews for nothing);
#   * the PR's head repository is not this repository (a fork), or the PR was
#     opened by dependabot[bot]. Those runs get repo secrets and OIDC on a
#     merge_group event, which a fork or Dependabot PR must never reach
#     (NEO-546 S3). Every job that uses a secret `needs:` the job running this
#     script, so exiting 1 here stops them before any secret is used.
set -uo pipefail

EVENT_NAME="${EVENT_NAME:-}"
REPO="${GITHUB_REPOSITORY:-}"

emit() {
  # emit <full> <pr> <sha> <head_sha> <head_ref> <reason>
  printf 'full=%s\npr=%s\nsha=%s\nhead_sha=%s\nhead_ref=%s\nreason=%s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6"
  echo "ci-mode: full=$1 pr=${2:-none} reason=$6" >&2
}

# The one predicate for "the merge queue is live": main's LIVE rules contain a
# merge_queue rule AND a required_status_checks rule requiring `CI Gate` pinned
# to the GitHub Actions app (integration id 15368, a number). Shared by cheap
# mode below and by `--check-ruleset`, which the pr-queue skills call, so CI and
# the skills can never disagree. Sets RULESET_STATE (live | off) and
# RULESET_REASON; any error is "off". Reads only; writes nothing.
queue_ruleset_state() {
  RULESET_STATE=off
  local rules verdict
  if ! rules=$(gh api "repos/${REPO}/rules/branches/main" 2>/dev/null) || [ -z "$rules" ]; then
    RULESET_REASON="could not read the branch rules (fail closed)"
    return
  fi
  # One jq pass over the SAME array: queue rule, and the pinned CI Gate.
  verdict=$(printf '%s' "$rules" | jq -r '
    if type == "array" then
      "queue=\(any(.[]; .type == "merge_queue"))",
      "gate=\(any(.[]; .type == "required_status_checks"
            and ((.parameters.required_status_checks // []) | type == "array")
            and ((.parameters.required_status_checks // [])
                 | any(.[]; .context == "CI Gate" and .integration_id == 15368))))"
    else "queue=error", "gate=error" end' 2>/dev/null) || verdict=""
  case "$verdict" in
    *queue=error*|"")
      RULESET_REASON="branch rules unreadable (fail closed)"; return ;;
    *queue=false*)
      RULESET_REASON="main has no merge_queue rule"; return ;;
  esac
  if ! printf '%s\n' "$verdict" | grep -qx 'gate=true'; then
    RULESET_REASON="main does not require CI Gate pinned to the GitHub Actions app"
    return
  fi
  RULESET_STATE=live
  RULESET_REASON="merge queue rule and pinned CI Gate present"
}

# `ci-mode.sh --check-ruleset`: print queue=live and exit 0 only when the
# predicate holds; otherwise print queue=off and exit 1 (errors included).
# Needs only GITHUB_REPOSITORY and an authenticated `gh`; never touches
# GITHUB_OUTPUT.
if [ "${1:-}" = "--check-ruleset" ]; then
  queue_ruleset_state
  echo "ci-mode: ${RULESET_REASON}" >&2
  if [ "$RULESET_STATE" = "live" ]; then echo "queue=live"; exit 0; fi
  echo "queue=off"
  exit 1
fi

case "$EVENT_NAME" in
  merge_group)
    ref="${GITHUB_REF:-}"
    ref="${ref#refs/heads/}"
    re='^gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]{7,40}$'
    if [[ ! "$ref" =~ $re ]]; then
      echo "::error::ci-mode: cannot read a PR number from the merge queue ref '${ref}'." >&2
      exit 1
    fi
    pr="${BASH_REMATCH[1]}"
    # The queue ref carries only the PR number. The PR's own head commit and
    # branch (the Convex preview is named after the branch) come from the API,
    # because head_ref is empty on a merge_group event.
    if ! info=$(gh api "repos/${REPO}/pulls/${pr}" \
        --jq '[.head.sha, .head.ref, (.head.repo.full_name // ""), (.user.login // "")] | @tsv' 2>/dev/null) \
        || [ -z "$info" ]; then
      echo "::error::ci-mode: could not read PR #${pr} to resolve its head commit and branch." >&2
      exit 1
    fi
    IFS=$'\t' read -r head_sha head_ref head_repo author <<<"$info"
    if [ -z "$head_sha" ] || [ -z "$head_ref" ] || [ -z "$head_repo" ] || [ -z "$author" ]; then
      echo "::error::ci-mode: PR #${pr} came back without a head sha, ref, repository or author." >&2
      exit 1
    fi
    if [ "$head_repo" != "$REPO" ]; then
      echo "::error::ci-mode: PR #${pr} comes from '${head_repo}', not this repository. A fork PR never runs in the merge queue with secrets." >&2
      exit 1
    fi
    if [ "$author" = "dependabot[bot]" ]; then
      echo "::error::ci-mode: PR #${pr} is a Dependabot PR; those are screening only and are never merged directly." >&2
      exit 1
    fi
    emit true "$pr" "${GITHUB_SHA:-}" "$head_sha" "$head_ref" "merge_group: the queue runs the full suite"
    ;;

  pull_request)
    pr="${PR_NUMBER:-}"
    sha="${PR_HEAD_SHA:-}"
    ref="${PR_HEAD_REF:-}"
    if [ -z "$pr" ]; then
      emit true "" "$sha" "$sha" "$ref" "pull_request without a PR number (fail closed)"
      exit 0
    fi
    if [ "${MERGE_QUEUE:-}" != "true" ]; then
      emit true "$pr" "$sha" "$sha" "$ref" "MERGE_QUEUE is not 'true': today's flow"
      exit 0
    fi
    queue_ruleset_state
    if [ "$RULESET_STATE" != "live" ]; then
      emit true "$pr" "$sha" "$sha" "$ref" "$RULESET_REASON"
      exit 0
    fi
    if ! labels=$(gh api "repos/${REPO}/pulls/${pr}" --jq '[.labels[].name] | join("\n")' 2>/dev/null); then
      emit true "$pr" "$sha" "$sha" "$ref" "could not read the PR labels (fail closed)"
      exit 0
    fi
    if printf '%s\n' "$labels" | grep -qxF 'run-e2e'; then
      emit true "$pr" "$sha" "$sha" "$ref" "run-e2e label forces the full suite"
      exit 0
    fi
    emit false "$pr" "$sha" "$sha" "$ref" "merge queue is live: cheap checks on the PR, full suite in the queue"
    ;;

  *)
    emit true "" "${GITHUB_SHA:-}" "${GITHUB_SHA:-}" "${GITHUB_REF_NAME:-}" "${EVENT_NAME:-unknown} event: full"
    ;;
esac
