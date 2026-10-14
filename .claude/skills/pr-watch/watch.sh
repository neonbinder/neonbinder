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
# Env knobs (all optional):
#   PR_WATCH_INTERVAL   seconds between ticks (default 120 = the ~2-min cadence)
#   PR_WATCH_MAX_MIN    safety stop in minutes (default 90)
#   PR_WATCH_REQUIRED_CHECK  the gate check that must be green before this
#                       reports GREEN (default "CI Gate"). See the note on the
#                       verdict in tick(): "no pending checks" alone is not a
#                       terminal state, because a freshly pushed SHA has only
#                       the fast third-party checks attached.
set -uo pipefail
{ set +x; } 2>/dev/null  # defensive: never trace

PR="${1:?usage: watch.sh <pr-number> [repo-dir]}"
REPO_DIR="${2:-.}"
INTERVAL="${PR_WATCH_INTERVAL:-120}"
MAX_MIN="${PR_WATCH_MAX_MIN:-90}"
REQUIRED_CHECK="${PR_WATCH_REQUIRED_CHECK:-CI Gate}"

cd "$REPO_DIR" 2>/dev/null || { echo "DONE ERROR — cannot cd to repo dir: $REPO_DIR"; exit 3; }

START=$(date +%s)
elapsed_min() { echo $(( ( $(date +%s) - START ) / 60 )); }

# ── one poll: prints a status line, sets VERDICT + FAILED_NAMES globals ──────
VERDICT="RUNNING"; FAILED_NAMES=""
tick() {
  local data state rollup total failed completed pending r_total r_done seed seedm gate pw
  data=$(gh pr view "$PR" --json state,statusCheckRollup 2>/dev/null) || {
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
