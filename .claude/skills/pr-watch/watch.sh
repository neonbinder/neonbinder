#!/usr/bin/env bash
# ─── pr-watch engine (NEO PR CI watcher) ─────────────────────────────────────
# Polls ONE GitHub PR's checks on a fixed cadence, prints exactly ONE status
# line per tick, and exits on a terminal state (all green / any failed /
# merged|closed / timeout). It is armed by the `pr-watch` SKILL via the Monitor
# tool FROM THE MAIN AGENT LOOP — so every printed line surfaces to the main
# agent as a notification (the ~2-minute progress update) and the final `DONE`
# line is the reliable terminal report.
#
# WHY a script (not inline Monitor command): the loop is non-trivial (verdict
# logic + per-job E2E progress) and we want it committed, reviewable, and
# testable on its own.
#
# READ-ONLY. The only network calls are read-only `gh` reads. It never
# comments, merges, pushes, edits, or mutates anything, and it needs no
# secret: E2E progress comes from the shard jobs on the PR's own check rollup.
#
# Usage:  watch.sh <pr-number> [repo-dir]
#         watch.sh --queue <pr-number> [repo-dir]
#
# --queue (GitHub merge queue, MERGE_QUEUE=true): follows the PR through the
# queue instead of its PR checks. A green PR run proves only the cheap checks;
# the full run is the merge_group run on gh-readonly-queue/main/pr-<N>-*. Its
# terminal lines are the only ones that mean anything:
#   DONE MERGED  — the PR merged (state MERGED on GitHub). Exit 0.
#   DONE EJECTED — dequeued by GitHub itself: an allowlisted automatic reason
#                  (failed check, timeout, conflict) AND a null/bot actor. Names
#                  the reason and the failing run/job URLs. Exit 1.
#   DONE REMOVED — everything else: a person, an unknown reason, a closed PR.
#                  Stop and tell the operator; never re-enqueue. Exit 4.
#   DONE NOT_QUEUED — never entered the queue within the grace window. Exit 5.
#   DONE TIMEOUT (2) / DONE ERROR (3) as in PR mode.
# Queue mode never prints GREEN.
# Env knobs (all optional):
#   PR_WATCH_INTERVAL   seconds between ticks (default 120 = the ~2-min cadence)
#   PR_WATCH_MAX_MIN    safety stop in minutes (default 90)
#   PR_WATCH_REQUIRED_CHECK  the gate check that must be green before this
#                       reports GREEN (default "CI Gate"). See the note on the
#                       verdict in tick(): "no pending checks" alone is not a
#                       terminal state, because a freshly pushed SHA has only
#                       the fast third-party checks attached.
#   PR_WATCH_QUEUE_MAX_MIN  safety stop for --queue (default 150; the queue's
#                       own timeout is 120)
#   PR_WATCH_ENQUEUE_GRACE_MIN  --queue: minutes to wait for the PR to appear
#                       in the queue before giving up (default 3)
#   PR_WATCH_REPO       --queue: the only repo this may watch (default
#                       neonbinder/neonbinder-app); every gh call passes -R to it
#   PR_WATCH_EJECT_REASONS  --queue: regex of dequeue reasons GitHub applies by
#                       itself. ONLY these (with a null/bot actor) are EJECTED;
#                       every other reason is REMOVED. CONFIRM AT D0.
#   PR_WATCH_GH         the gh binary (default gh); tests point it at a fake
set -uo pipefail
{ set +x; } 2>/dev/null  # defensive: never trace

MODE="pr"
if [ "${1:-}" = "--queue" ]; then MODE="queue"; shift; fi
PR="${1:?usage: watch.sh [--queue] <pr-number> [repo-dir]}"
REPO_DIR="${2:-.}"
INTERVAL="${PR_WATCH_INTERVAL:-120}"
MAX_MIN="${PR_WATCH_MAX_MIN:-90}"
[ "$MODE" = "queue" ] && MAX_MIN="${PR_WATCH_QUEUE_MAX_MIN:-150}"
GRACE_MIN="${PR_WATCH_ENQUEUE_GRACE_MIN:-3}"
GH="${PR_WATCH_GH:-gh}"
EXPECTED_REPO="${PR_WATCH_REPO:-neonbinder/neonbinder-app}"
# Automatic dequeue reasons. CONFIRM AT D0 (the first enqueue/dequeue dry run):
# GitHub documents the event's `reason` only loosely, so this is a guess at the
# strings it uses. Unknown reasons deliberately fall to REMOVED (stop, tell a person).
EJECT_REASONS="${PR_WATCH_EJECT_REASONS:-^(CI_FAILURE|CI_TIMEOUT|TIMEOUT|MERGE_CONFLICT|QUEUE_CONFLICT|INVALID_MERGE_COMMIT|BRANCH_PROTECTIONS|DEPLOYMENT_FAILURE)$}"
case "$PR" in ''|*[!0-9]*) echo "DONE ERROR — PR number must be digits: $PR"; exit 3;; esac
REQUIRED_CHECK="${PR_WATCH_REQUIRED_CHECK:-CI Gate}"

cd "$REPO_DIR" 2>/dev/null || { echo "DONE ERROR — cannot cd to repo dir: $REPO_DIR"; exit 3; }

START=$(date +%s)
elapsed_min() { echo $(( ( $(date +%s) - START ) / 60 )); }

# ── one poll: prints a status line, sets VERDICT + FAILED_NAMES globals ──────
VERDICT="RUNNING"; FAILED_NAMES=""
tick() {
  local data state rollup total failed completed pending r_total r_done seed seedm gate pw
  data=$($GH pr view "$PR" --json state,statusCheckRollup 2>/dev/null) || {
    echo "[t+$(elapsed_min)m] poll error (gh read failed) — will retry next tick"; VERDICT="RUNNING"; return 0; }
  state=$(echo "$data" | jq -r '.state // "OPEN"')
  rollup=$(echo "$data" | jq -c '[.statusCheckRollup[]? | {name:(.name // .context // ""), s:(.status // .state // ""), c:(.conclusion // .state // "")}]')

  total=$(echo "$rollup"     | jq 'length')
  failed=$(echo "$rollup"    | jq '[.[]|select(.c=="FAILURE" or .c=="CANCELLED" or .c=="TIMED_OUT" or .c=="STARTUP_FAILURE" or .c=="ACTION_REQUIRED")]|length')
  completed=$(echo "$rollup" | jq '[.[]|select(.s=="COMPLETED" or .c=="SUCCESS" or .c=="FAILURE" or .c=="NEUTRAL" or .c=="SKIPPED" or .c=="CANCELLED" or .c=="TIMED_OUT")]|length')
  pending=$(( total - completed ))
  # The reusable e2e.yml runs two passes and its jobs surface as "E2E / seed",
  # "E2E / shard-desktop (N, W)", "E2E / seed-mobile", "E2E / shard-mobile
  # (N, W)", "E2E / e2e" (the prefix is the calling job's name). Shards are
  # counted across both passes (16 when both have started).
  r_total=$(echo "$rollup"   | jq '[.[]|select(.name|test("(^|/ )shard-(desktop|mobile) \\("))]|length')
  r_done=$(echo "$rollup"    | jq '[.[]|select((.name|test("(^|/ )shard-(desktop|mobile) \\(")) and (.s=="COMPLETED"))]|length')

  # The gate check's own conclusion — see the GREEN condition below.
  local req
  req=$(echo "$rollup" | jq -r --arg n "$REQUIRED_CHECK" \
    'first(.[]|select(.name==$n)) | (if (.c|length)>0 then .c else .s end) // ""')

  symbol() { case "$1" in SUCCESS) echo ✓;; FAILURE|CANCELLED|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED) echo ✗;; NEUTRAL|SKIPPED) echo ⊘;; COMPLETED) echo ✓;; "") echo —;; *) echo ▶;; esac; }
  named() { echo "$rollup" | jq -r --arg re "$1" 'first(.[]|select(.name|test($re;"i"))) | (if (.c|length)>0 then .c else .s end) // "—"' 2>/dev/null; }
  seed=$(symbol "$(named "(^|/ )seed$")"); seedm=$(symbol "$(named "(^|/ )seed-mobile$")"); gate=$(symbol "$(named "(^|/ )e2e$")"); pw=$(symbol "$(named "^Playwright E2E$")")

  # ── verdict (GitHub is the source of truth) ──
  if [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then VERDICT="$state"
  elif [ "${failed:-0}" -gt 0 ]; then
    VERDICT="FAILED"
    FAILED_NAMES=$(echo "$rollup" | jq -r '[.[]|select(.c=="FAILURE" or .c=="CANCELLED" or .c=="TIMED_OUT" or .c=="STARTUP_FAILURE" or .c=="ACTION_REQUIRED")|.name]|join(", ")')
  elif [ "${total:-0}" -gt 0 ] && [ "${pending:-0}" -eq 0 ] && [ -n "$req" ] &&
       { [ "$req" = "SUCCESS" ] || [ "$req" = "SKIPPED" ] || [ "$req" = "NEUTRAL" ]; }; then
    VERDICT="GREEN"
  else VERDICT="RUNNING"; fi

  # "Nothing pending" is NOT the same as "the pipeline finished". Right after a
  # push, GitHub has attached only the fast third-party checks (Vercel answers in
  # seconds) while the PR Pipeline run is still queued and has registered nothing.
  # The old condition — total>0 && pending==0 — read that as GREEN and exited, so
  # every push produced a confident, wrong "mergeable" ~30s later. It happened
  # four times in one session on PRs #117 and #119.
  #
  # $REQUIRED_CHECK is the pipeline's own gate job, which depends on every other
  # job, so it cannot be green before the pipeline is genuinely done, and it is
  # absent entirely until the run registers. Waiting on it is what distinguishes
  # "finished" from "not started". SKIPPED/NEUTRAL count as satisfied so a PR
  # whose pipeline legitimately skips does not sit here until the safety timeout.
  local waiting=""
  [ "$VERDICT" = "RUNNING" ] && [ "${pending:-0}" -eq 0 ] && [ -z "$req" ] &&
    waiting=" · waiting for ${REQUIRED_CHECK} (pipeline not registered yet)"

  printf '[t+%sm] %s — checks %s/%s done, %s failed · seed %s/%s · shards %s/%s · e2e %s · playwright %s%s\n' \
    "$(elapsed_min)" "$VERDICT" "$completed" "$total" "$failed" "$seed" "$seedm" "$r_done" "$r_total" "$gate" "$pw" "$waiting"
}


# ── queue mode ───────────────────────────────────────────────────────────────
# One poll of the merge queue. Sets VERDICT (RUNNING|MERGED|EJECTED|REMOVED) and
# DETAIL, prints one status line. Three reads, all read-only: the PR (state,
# queue entry, queue timeline events), the merge_group runs on this PR's queue
# branch, and those runs' jobs.
# shellcheck disable=SC2016  # GraphQL variables, not shell
QUERY='query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeCommit{oid} mergeQueueEntry{state position} timelineItems(last:20,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename ... on AddedToMergeQueueEvent{createdAt} ... on RemovedFromMergeQueueEvent{createdAt reason actor{__typename login}}}}}}}'
OWNER=""; NAME=""; DETAIL=""; NOT_QUEUED_TICKS=0

# Failing jobs (url list) of the runs in $1 (JSON array of runs with .jobs).
failing_jobs() {
  echo "$1" | jq -r '
    [.[] | .workflowName as $w | .jobs[]? | {w:$w, n:.name, u:.url, c:((.conclusion // "")|ascii_upcase)}] as $j
    | ([$j[]|select(.c=="FAILURE" or .c=="TIMED_OUT" or .c=="STARTUP_FAILURE")]) as $hard
    | (if ($hard|length)>0 then $hard else [$j[]|select(.c=="CANCELLED")] end)
    | .[:5] | map("\(.w) / \(.n): \(.u)") | join("; ")'
}

tick_queue() {
  local pr state last_add last_rem rem_reason rem_actor rem_bot runs group
  local mq_state mq_pos nruns nrun_active jtotal jdone shards_t shards_d gate
  pr=$($GH api graphql -f query="$QUERY" -F owner="$OWNER" -F name="$NAME" -F pr="$PR" 2>/dev/null \
        | jq -c '.data.repository.pullRequest // empty') || pr=""
  if [ -z "$pr" ]; then
    echo "[t+$(elapsed_min)m] poll error (gh read failed) — will retry next tick"; VERDICT="RUNNING"; return 0; fi
  state=$(echo "$pr" | jq -r '.state')
  mq_state=$(echo "$pr" | jq -r '.mergeQueueEntry.state // ""')
  mq_pos=$(echo "$pr" | jq -r '.mergeQueueEntry.position // ""')
  last_add=$(echo "$pr" | jq -r '[.timelineItems.nodes[]?|select(.__typename=="AddedToMergeQueueEvent")|.createdAt]|max // ""')
  last_rem=$(echo "$pr" | jq -r '[.timelineItems.nodes[]?|select(.__typename=="RemovedFromMergeQueueEvent")|.createdAt]|max // ""')
  rem_reason=$(echo "$pr" | jq -r --arg t "$last_rem" 'first(.timelineItems.nodes[]?|select(.__typename=="RemovedFromMergeQueueEvent" and .createdAt==$t))|.reason // "unknown"')
  rem_actor=$(echo "$pr" | jq -r --arg t "$last_rem" 'first(.timelineItems.nodes[]?|select(.__typename=="RemovedFromMergeQueueEvent" and .createdAt==$t))|.actor.login // ""')
  # A null actor or a bot is GitHub acting by itself; anything else is a person.
  rem_bot=$(echo "$pr" | jq -r --arg t "$last_rem" 'first(.timelineItems.nodes[]?|select(.__typename=="RemovedFromMergeQueueEvent" and .createdAt==$t))|(.actor // null) as $a | if $a==null or ($a.__typename=="Bot") or (($a.login//"")|test("\\[bot\\]$")) then "yes" else "no" end')

  # merge_group runs for THIS pr, from its latest enqueue on (an earlier ejected
  # attempt's runs must not colour the current one). Newest-attempt filter is a
  # string compare on ISO-8601, which orders correctly.
  runs=$($GH run list -R "$EXPECTED_REPO" --event merge_group --limit 100 \
          --json databaseId,headBranch,status,conclusion,url,workflowName,createdAt 2>/dev/null \
        | jq -c --arg p "gh-readonly-queue/main/pr-$PR-" --arg since "$last_add" \
            '[.[]|select(.headBranch|startswith($p))|select($since=="" or .createdAt>=$since)]') || runs="[]"
  [ -z "$runs" ] && runs="[]"
  nruns=$(echo "$runs" | jq 'length')
  nrun_active=$(echo "$runs" | jq '[.[]|select(.status!="completed")]|length')
  group="[]"
  local id
  for id in $(echo "$runs" | jq -r '.[].databaseId'); do
    local one
    one=$($GH run view "$id" -R "$EXPECTED_REPO" --json jobs 2>/dev/null | jq -c --argjson r "$(echo "$runs" | jq -c --argjson i "$id" 'first(.[]|select(.databaseId==$i))')" \
            '{workflowName:$r.workflowName, jobs:(.jobs // [])}') || one=""
    [ -n "$one" ] && group=$(echo "$group" | jq -c --argjson o "$one" '. + [$o]')
  done
  jtotal=$(echo "$group" | jq '[.[].jobs[]?]|length')
  jdone=$(echo "$group"  | jq '[.[].jobs[]?|select(.status=="completed")]|length')
  shards_t=$(echo "$group" | jq '[.[].jobs[]?|select(.name|test("(^|/ )shard-(desktop|mobile) \\("))]|length')
  shards_d=$(echo "$group" | jq '[.[].jobs[]?|select((.name|test("(^|/ )shard-(desktop|mobile) \\(")) and .status=="completed")]|length')
  gate=$(echo "$group" | jq -r --arg n "$REQUIRED_CHECK" 'first(.[].jobs[]?|select(.name==$n))|(if (.conclusion//"")!="" then .conclusion else .status end)//"—"')
  local fj; fj=$(failing_jobs "$group")
  DETAIL=""

  # ── verdict: GitHub's PR state is the only source of MERGED ──
  if [ "$state" = "MERGED" ]; then
    VERDICT="MERGED"; DETAIL="merge commit $(echo "$pr" | jq -r '.mergeCommit.oid // "unknown"')"
  elif [ -n "$mq_state" ]; then
    VERDICT="RUNNING"
  elif [ "$state" = "CLOSED" ]; then
    VERDICT="REMOVED"; DETAIL="PR closed without merging"
  elif [ -n "$last_rem" ] && { [ -z "$last_add" ] || [ "$last_rem" \> "$last_add" ] || [ "$last_rem" = "$last_add" ]; }; then
    # Dequeued after its latest enqueue. EJECTED only for an allowlisted
    # automatic reason AND a null/bot actor (GitHub did it, the session may fix
    # and re-enqueue). Everything else, an unknown reason or a person, is
    # REMOVED: stop and tell the operator, never re-enqueue. Wrongly calling an
    # ejection REMOVED costs a message; the reverse re-enqueues something a person
    # pulled on purpose.
    local failed_runs
    failed_runs=$(echo "$runs" | jq -r '[.[]|select((.conclusion//"")|test("failure|timed_out|startup_failure";"i"))|.url]|.[:5]|join("; ")')
    if ! echo "$rem_reason" | grep -Eq -- "$EJECT_REASONS" || [ "$rem_bot" != "yes" ]; then
      VERDICT="REMOVED"; DETAIL="dequeued, reason: $rem_reason, actor: ${rem_actor:-none} — not a known automatic ejection; stop and tell the operator, do not re-enqueue"
    else
      VERDICT="EJECTED"
      DETAIL="dequeued, reason: $rem_reason${rem_actor:+ (actor $rem_actor)}"
      [ -n "$fj" ] && DETAIL="$DETAIL; failing job(s): $fj"
      [ -z "$fj" ] && [ -n "$failed_runs" ] && DETAIL="$DETAIL; failing run(s): $failed_runs"
      [ -z "$fj" ] && [ -z "$failed_runs" ] && DETAIL="$DETAIL; no failing job found (timeout, conflict or cancelled before it ran): check gh run list --event merge_group"
    fi
  else
    # OPEN, not in the queue, never dequeued: not enqueued yet (or events lag).
    NOT_QUEUED_TICKS=$((NOT_QUEUED_TICKS + 1))
    VERDICT="RUNNING"
    if [ "$(elapsed_min)" -ge "$GRACE_MIN" ]; then VERDICT="NOT_QUEUED"
      DETAIL="PR is open and not in the merge queue after ${GRACE_MIN}m"; fi
  fi

  local phase
  if [ -n "$mq_state" ] && [ "$nruns" -eq 0 ]; then phase="queued (${mq_state}${mq_pos:+, position $mq_pos}) — waiting for its merge group to start"
  elif [ -n "$mq_state" ]; then phase="${mq_state}${mq_pos:+ pos $mq_pos} · group runs ${nrun_active} active/${nruns} · jobs ${jdone}/${jtotal} done · shards ${shards_d}/${shards_t} · ${REQUIRED_CHECK} ${gate}"
  elif [ "$VERDICT" = "RUNNING" ]; then phase="not in the queue yet (waiting for the enqueue to register)"
  else phase="${DETAIL}"; fi
  printf '[t+%sm] %s — %s\n' "$(elapsed_min)" "$VERDICT" "$phase"
}

queue_main() {
  local repo
  repo=$($GH repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || repo=""
  if [ "$repo" != "$EXPECTED_REPO" ]; then
    echo "DONE ERROR — $REPO_DIR is repo '${repo:-unknown}', queue mode only watches $EXPECTED_REPO"; exit 3; fi
  OWNER="${repo%%/*}"; NAME="${repo#*/}"
  while true; do
    tick_queue
    case "$VERDICT" in
      MERGED)     echo "DONE MERGED — PR #$PR merged ($DETAIL; watched $(elapsed_min)m)."; exit 0 ;;
      EJECTED)    echo "DONE EJECTED — PR #$PR left the merge queue: $DETAIL (watched $(elapsed_min)m)."; exit 1 ;;
      REMOVED)    echo "DONE REMOVED — PR #$PR: $DETAIL (watched $(elapsed_min)m)."; exit 4 ;;
      NOT_QUEUED) echo "DONE NOT_QUEUED — PR #$PR: $DETAIL."; exit 5 ;;
    esac
    if [ "$(elapsed_min)" -ge "$MAX_MIN" ]; then
      echo "DONE TIMEOUT — PR #$PR still in the queue after ${MAX_MIN}m; stopping watch."; exit 2
    fi
    sleep "$INTERVAL"
  done
}

[ "$MODE" = "queue" ] && queue_main

# ── main loop ────────────────────────────────────────────────────────────────
while true; do
  tick
  case "$VERDICT" in
    GREEN)  echo "DONE GREEN — all checks passed (watched $(elapsed_min)m). PR #$PR is mergeable."; exit 0 ;;
    FAILED) echo "DONE FAILED — failing check(s): ${FAILED_NAMES:-unknown} (watched $(elapsed_min)m). PR #$PR."; exit 1 ;;
    MERGED|CLOSED) echo "DONE $VERDICT — PR #$PR is $VERDICT (watched $(elapsed_min)m)."; exit 0 ;;
  esac
  if [ "$(elapsed_min)" -ge "$MAX_MIN" ]; then
    echo "DONE TIMEOUT — PR #$PR still running after ${MAX_MIN}m; stopping watch."; exit 2
  fi
  sleep "$INTERVAL"
done
