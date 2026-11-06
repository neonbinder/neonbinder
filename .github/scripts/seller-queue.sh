#!/usr/bin/env bash
# Wait for this job's turn on the shared marketplace seller accounts (NEO-415).
#
# Called by e2e.yml's seller-desktop and seller-mobile jobs, as the step named
# the step named STEP_NAME below ("held" means a job has passed that step). Every PR's CI shares one BuySportsCards and one eBay
# sandbox seller, so only one seller job may run repo-wide. GitHub's
# `concurrency` cannot queue (it cancels an older pending job when a third
# joins), so this polls the repo's own runs and goes when
#   1. no seller job has passed this step and is still running, and
#   2. no seller job that has not passed it started earlier (start time, then
#      job id).
# Both `in_progress` and `queued` runs are read: GitHub can call a run `queued`
# while one of its jobs runs (seen on a rerun, NEO-445). From a run it calls
# `queued` only a RUNNING seller job counts. One that has not started does not:
# that run may be queued behind its own PR's run, which may be waiting on this
# very queue, so counting it could deadlock until the cap (a run in progress
# keeps the original rule, by start time).
# First come, first served, never a cancel. A cancelled or dead holder shows as
# completed and stops counting at once; a job older than 3 h is ignored as
# stuck. The wait is bounded (SELLER_QUEUE_MAX_MIN, default 60).
#
# Trust: only runs whose head repository is THIS repository are read (a run with
# no head repository, e.g. a workflow_dispatch, counts when its own repository is this one). A fork
# PR runs its own copy of the workflows, so it could otherwise forge a holder
# job. The poll fails CLOSED: any API error, a truncated listing, or a missing
# own-job row is "unreadable", which waits and never goes. Nothing read from
# another run is echoed except numeric run ids (job names are attacker-shaped
# on a branch and could carry workflow commands).
#
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, RUNNER_NAME,
#      SELLER_QUEUE_MAX_MIN (60), SELLER_QUEUE_POLL_S (100), SELLER_QUEUE_BACKOFF_S (300),
#      GH (the gh binary, default gh; tests only).
set -uo pipefail

# The one definition of the queue step's name and of which jobs are seller jobs.
# e2e.yml's two queue steps must be named exactly STEP_NAME and its two job
# `name:`s must match JOB_RE (the `E2E / ` prefix is the caller job in
# pr-pipeline.yml); seller-queue.test.mjs greps e2e.yml for drift.
STEP_NAME='Wait for the seller queue'
JOB_RE='^(E2E / )?Marketplace seller specs \((desktop|mobile)\)$'
WORKFLOWS=(pr-pipeline.yml e2e.yml)
PER_PAGE=100

GH="${GH:-gh}"
max_min="${SELLER_QUEUE_MAX_MIN:-60}"
poll_s="${SELLER_QUEUE_POLL_S:-100}"
backoff_s="${SELLER_QUEUE_BACKOFF_S:-300}"

# Neutralise workflow-command prefixes (`::` and the legacy `##[`) in anything echoed.
safe() { tr -d '\r' | sed -e 's/::/: :/g' -e 's/##\[/## [/g' | head -c 300; }

me_id=""; me_at=""; body=""
rate=""
sleep_extra=0
err=""

# api <path>: body in $body; non-zero on any failure, stderr kept in $err.
# (Not run in a subshell, so $err and $sleep_extra reach the caller.)
api() {
  local status
  body=$("$GH" api "$1" 2>"$RUNNER_TMP_ERR"); status=$?
  err=$(safe <"$RUNNER_TMP_ERR")
  if [ $status -ne 0 ]; then
    if printf '%s' "$err" | grep -qiE 'HTTP (403|429)|rate limit'; then sleep_extra=$backoff_s; fi
    return 1
  fi
}
RUNNER_TMP_ERR="$(mktemp)"
trap 'rm -f "$RUNNER_TMP_ERR"' EXIT

# seller_jobs <jobs-json>: one JSON object per seller job that is not completed.
# Fails (unreadable) when the listing is truncated.
seller_jobs() {
  jq -c --arg re "$JOB_RE" --arg step "$STEP_NAME" '
    if (.total_count // 0) > '"$PER_PAGE"' or (.jobs | type) != "array" then error("truncated")
    else .jobs[]
      | select(.name | test($re))
      | select(.status != "completed")
      | {id, run: .run_id, status, runner: .runner_name, at: (.started_at // .created_at),
         held: ([.steps[]? | select(.name == $step and .status == "completed" and .conclusion == "success")] | length > 0)}
    end' <<<"$1"
}

# poll: sets DECISION to "go", "wait: ..." or "unreadable: ...".
poll() {
  local rows runs rid wf status all="" now in_progress="" queued=""
  now=$(date +%s)
  # 1. Our own place in line, read once (it never changes).
  if [ -z "$me_id" ]; then
    api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs?per_page=$PER_PAGE" \
      || { DECISION="unreadable: could not read this run's jobs ($err)"; return; }
    rows=$(seller_jobs "$body") || { DECISION="unreadable: this run's job list was truncated or malformed"; return; }
    local mine
    mine=$(jq -sc --arg runner "$RUNNER_NAME" 'map(select(.runner == $runner)) | first // empty' <<<"$rows")
    if [ -z "$mine" ]; then DECISION="unreadable: this job is not in its run's job list yet (is its name still 'Marketplace seller specs (desktop|mobile)'?)"; return; fi
    me_id=$(jq -r .id <<<"$mine"); me_at=$(jq -r .at <<<"$mine")
  fi
  # 2. Everyone else, this repository's runs only.
  for wf in "${WORKFLOWS[@]}"; do
    for status in in_progress queued; do
      api "repos/$GITHUB_REPOSITORY/actions/workflows/$wf/runs?status=$status&per_page=$PER_PAGE" \
        || { DECISION="unreadable: could not list $wf runs ($err)"; return; }
      runs=$(jq -r --arg repo "$GITHUB_REPOSITORY" --arg me "$GITHUB_RUN_ID" '
        if (.total_count // 0) > '"$PER_PAGE"' or (.workflow_runs | type) != "array" then error("truncated")
        else .workflow_runs[]
          | select((.head_repository.full_name // .repository.full_name) == $repo)
          | select((.id | tostring) != $me) | .id end' <<<"$body") \
        || { DECISION="unreadable: $wf run list truncated or malformed"; return; }
      if [ "$status" = queued ]; then queued+="$runs"$'\n'; else in_progress+="$runs"$'\n'; fi
    done
  done
  # One read per run id, however often it was listed; in progress wins, as a run
  # can change status between the two calls.
  in_progress=$(printf '%s' "$in_progress" | sort -u)
  queued=$(printf '%s' "$queued" | sort -u | comm -13 <(printf '%s\n' "$in_progress") -)
  for rid in $in_progress; do
    api "repos/$GITHUB_REPOSITORY/actions/runs/$rid/jobs?per_page=$PER_PAGE" \
      || { DECISION="unreadable: could not read the jobs of run $rid ($err)"; return; }
    rows=$(seller_jobs "$body") || { DECISION="unreadable: run $rid job list truncated or malformed"; return; }
    all+="$rows"$'\n'
  done
  for rid in $queued; do
    api "repos/$GITHUB_REPOSITORY/actions/runs/$rid/jobs?per_page=$PER_PAGE" \
      || { DECISION="unreadable: could not read the jobs of run $rid ($err)"; return; }
    rows=$(seller_jobs "$body") || { DECISION="unreadable: run $rid job list truncated or malformed"; return; }
    rows=$(jq -c 'select(.status == "in_progress")' <<<"$rows") \
      || { DECISION="unreadable: run $rid job list truncated or malformed"; return; }
    all+="$rows"$'\n'
  done
  DECISION=$(jq -rs --arg me_id "$me_id" --arg me_at "$me_at" --argjson now "$now" '
    [ .[] | select((.id | tostring) != $me_id)
      | select((.at | fromdateiso8601) > ($now - 10800))
      | select(.held or (.at < $me_at) or (.at == $me_at and .id < ($me_id | tonumber))) ] as $ahead
    | if ($ahead | length) == 0 then "go"
      else "wait: " + ($ahead | length | tostring) + " ahead: "
           + ($ahead | map("run " + (.run | tostring) + (if .held then " (running)" else " (queued)" end)) | join(", ")) end' <<<"$all") \
    || DECISION="unreadable: could not evaluate the queue"
}

began=$(date +%s); deadline=$(( began + max_min * 60 )); last=""; unreadable_seen=0
while :; do
  sleep_extra=0
  poll
  [ "$DECISION" = "go" ] && { echo "Seller queue: our turn after $(( $(date +%s) - began ))s."; exit 0; }
  case "$DECISION" in unreadable*) unreadable_seen=1 ;; *) unreadable_seen=0 ;; esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ $unreadable_seen -eq 1 ]; then
      echo "::error::Gave up after ${max_min} min: the seller queue could not be read (${DECISION}). This is an API or workflow problem, not other PRs; re-run the workflow."
    else
      echo "::error::Waited ${max_min} min for the shared marketplace seller accounts (${DECISION}). Re-run this workflow once the queue clears; nothing is wrong with this change."
    fi
    exit 1
  fi
  rate=$("$GH" api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo "?")
  line="Seller queue [$(( ($(date +%s) - began) / 60 )) min, API calls left ${rate}]: ${DECISION}"
  if [ "$line" != "$last" ] || [ "$sleep_extra" -gt 0 ]; then echo "$line"; last="$line"; fi
  wait_s=$(( poll_s > sleep_extra ? poll_s : sleep_extra ))
  remaining=$(( deadline - $(date +%s) )); [ "$wait_s" -gt "$remaining" ] && wait_s=$(( remaining > 0 ? remaining : 1 ))
  sleep "$wait_s"
done
