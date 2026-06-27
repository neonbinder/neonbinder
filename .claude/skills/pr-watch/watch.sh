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
# logic + best-effort Convex queue enrichment) and we want it committed,
# reviewable, and testable on its own.
#
# READ-ONLY. The only network calls are read-only `gh` reads and an OPTIONAL
# read-only POST to the preview Convex `/e2e/status` query. It never comments,
# merges, pushes, edits, or mutates anything. The E2E queue secret is only ever
# sent as a header and is NEVER printed (NEO-29 discipline).
#
# Usage:  watch.sh <pr-number> [repo-dir]
# Env knobs (all optional):
#   PR_WATCH_INTERVAL   seconds between ticks (default 120 = the ~2-min cadence)
#   PR_WATCH_MAX_MIN    safety stop in minutes (default 90)
#   E2E_QUEUE_SECRET    skip the convex env lookup if already set
#   CONVEX_SITE_URL     skip preview resolution if already set
#   PR_WATCH_NO_QUEUE=1 disable the Convex queue enrichment entirely (gh-only)
set -uo pipefail
{ set +x; } 2>/dev/null  # defensive: never trace (the queue secret flows through here)

PR="${1:?usage: watch.sh <pr-number> [repo-dir]}"
REPO_DIR="${2:-.}"
INTERVAL="${PR_WATCH_INTERVAL:-120}"
MAX_MIN="${PR_WATCH_MAX_MIN:-90}"

cd "$REPO_DIR" 2>/dev/null || { echo "DONE ERROR — cannot cd to repo dir: $REPO_DIR"; exit 3; }

START=$(date +%s)
elapsed_min() { echo $(( ( $(date +%s) - START ) / 60 )); }

# ── helpers ──────────────────────────────────────────────────────────────────
read_env_key() { # read_env_key FILE KEY -> echoes value (caller must NOT log it)
  [ -f "$1" ] || return 1
  local line; line=$(grep -m1 -E "^$2=" "$1" 2>/dev/null) || return 1
  line="${line#*=}"; line="${line%$'\r'}"
  case "$line" in
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
    \'*\') line="${line#\'}"; line="${line%\'}" ;;
  esac
  printf '%s' "$line"
}

# ── best-effort Convex queue resolution (ONCE, before the loop) ──────────────
# Mirrors how the CI `setup` job derives the preview .convex.site URL: read the
# preview index.html (behind Vercel Deployment Protection, so it needs the
# bypass header), pull the `x-convex-url` <meta>, swap .convex.cloud→.convex.site.
# The queue secret comes from read-only `convex env get` (dev/preview only; the
# function fails closed in prod). If ANY piece is missing we silently fall back
# to GitHub-only — the `e2e` gate check is the source of truth for green/red, so
# the queue line is purely finer-grained progress.
QUEUE_READY=0
E2E_RUN_ID="${E2E_RUN_ID:-}"
resolve_queue() {
  [ "${PR_WATCH_NO_QUEUE:-0}" = 1 ] && return 1

  # Queue scope == the workflow run id; pull it from a check's details URL.
  if [ -z "$E2E_RUN_ID" ]; then
    E2E_RUN_ID=$(gh pr view "$PR" --json statusCheckRollup \
      --jq 'first(.statusCheckRollup[]? | (.detailsUrl // .targetUrl // "") | select(test("/actions/runs/[0-9]+")) | capture("/actions/runs/(?<id>[0-9]+)").id) // empty' 2>/dev/null)
  fi
  [ -z "$E2E_RUN_ID" ] && return 1

  # Secret (header-only, never printed).
  if [ -z "${E2E_QUEUE_SECRET:-}" ]; then
    E2E_QUEUE_SECRET=$(npx --no-install convex env get E2E_QUEUE_SECRET 2>/dev/null | tr -d '\r\n')
  fi
  [ -z "${E2E_QUEUE_SECRET:-}" ] && return 1

  # Preview .convex.site URL.
  if [ -z "${CONVEX_SITE_URL:-}" ]; then
    local bypass sha dep purl html cloud
    bypass="${VERCEL_AUTOMATION_BYPASS_SECRET:-$(read_env_key .env.local VERCEL_AUTOMATION_BYPASS_SECRET)}"
    [ -z "$bypass" ] && return 1
    sha=$(gh pr view "$PR" --json headRefOid --jq .headRefOid 2>/dev/null)
    [ -z "$sha" ] && return 1
    dep=$(gh api "repos/{owner}/{repo}/deployments?sha=$sha&per_page=100" \
      --jq '[.[]|select(.creator.login=="vercel[bot]")]|sort_by(.created_at)|reverse|.[0].id // empty' 2>/dev/null)
    [ -z "$dep" ] && return 1
    purl=$(gh api "repos/{owner}/{repo}/deployments/$dep/statuses" \
      --jq 'first(.[]|select(.state=="success")|(.environment_url // .target_url)) // empty' 2>/dev/null)
    [ -z "$purl" ] && return 1
    html=$(curl -sS -H "x-vercel-protection-bypass: $bypass" "${purl%/}/" 2>/dev/null) || return 1
    cloud=$(printf '%s' "$html" | grep -oE 'name="x-convex-url" content="[^"]*"' \
      | grep -oE 'https://[a-z0-9-]+\.convex\.cloud' | head -1)
    [ -z "$cloud" ] && return 1
    CONVEX_SITE_URL="${cloud/.convex.cloud/.convex.site}"
  fi
  [ -z "${CONVEX_SITE_URL:-}" ] && return 1
  QUEUE_READY=1
}

queue_line() { # echoes " · queue 24✓ 1✗ 4▶ 16⋯/45" or "" (best-effort, never fails the tick)
  [ "$QUEUE_READY" = 1 ] || { printf ''; return; }
  local j
  j=$(curl -fsS -X POST "${CONVEX_SITE_URL%/}/e2e/status" \
        -H "x-e2e-queue-secret: ${E2E_QUEUE_SECRET}" -H "Content-Type: application/json" \
        -d "{\"runId\":\"${E2E_RUN_ID}\"}" 2>/dev/null) || { printf ''; return; }
  printf '%s' "$(echo "$j" | jq -r '" · queue \(.passed)✓ \(.failed)✗ \(.running)▶ \(.pending)⋯/\(.total)"' 2>/dev/null)"
}

# ── one poll: prints a status line, sets VERDICT + FAILED_NAMES globals ──────
VERDICT="RUNNING"; FAILED_NAMES=""
tick() {
  local data state rollup total failed completed pending r_total r_done seed gate maestro
  data=$(gh pr view "$PR" --json state,statusCheckRollup 2>/dev/null) || {
    echo "[t+$(elapsed_min)m] poll error (gh read failed) — will retry next tick"; VERDICT="RUNNING"; return 0; }
  state=$(echo "$data" | jq -r '.state // "OPEN"')
  rollup=$(echo "$data" | jq -c '[.statusCheckRollup[]? | {name:(.name // .context // ""), s:(.status // .state // ""), c:(.conclusion // .state // "")}]')

  total=$(echo "$rollup"     | jq 'length')
  failed=$(echo "$rollup"    | jq '[.[]|select(.c=="FAILURE" or .c=="CANCELLED" or .c=="TIMED_OUT" or .c=="STARTUP_FAILURE" or .c=="ACTION_REQUIRED")]|length')
  completed=$(echo "$rollup" | jq '[.[]|select(.s=="COMPLETED" or .c=="SUCCESS" or .c=="FAILURE" or .c=="NEUTRAL" or .c=="SKIPPED" or .c=="CANCELLED" or .c=="TIMED_OUT")]|length')
  pending=$(( total - completed ))
  r_total=$(echo "$rollup"   | jq '[.[]|select(.name|test("^runner"))]|length')
  r_done=$(echo "$rollup"    | jq '[.[]|select((.name|test("^runner")) and (.s=="COMPLETED"))]|length')

  symbol() { case "$1" in SUCCESS) echo ✓;; FAILURE|CANCELLED|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED) echo ✗;; NEUTRAL|SKIPPED) echo ⊘;; COMPLETED) echo ✓;; "") echo —;; *) echo ▶;; esac; }
  named() { echo "$rollup" | jq -r --arg re "$1" 'first(.[]|select(.name|test($re;"i"))) | (if (.c|length)>0 then .c else .s end) // "—"' 2>/dev/null; }
  seed=$(symbol "$(named "^seed$")"); gate=$(symbol "$(named "^e2e$")"); maestro=$(symbol "$(named "maestro")")

  # ── verdict (GitHub is the source of truth) ──
  if [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then VERDICT="$state"
  elif [ "${failed:-0}" -gt 0 ]; then
    VERDICT="FAILED"
    FAILED_NAMES=$(echo "$rollup" | jq -r '[.[]|select(.c=="FAILURE" or .c=="CANCELLED" or .c=="TIMED_OUT" or .c=="STARTUP_FAILURE" or .c=="ACTION_REQUIRED")|.name]|join(", ")')
  elif [ "${total:-0}" -gt 0 ] && [ "${pending:-0}" -eq 0 ]; then VERDICT="GREEN"
  else VERDICT="RUNNING"; fi

  printf '[t+%sm] %s — checks %s/%s done, %s failed · seed %s · runners %s/%s · e2e %s · maestro %s%s\n' \
    "$(elapsed_min)" "$VERDICT" "$completed" "$total" "$failed" "$seed" "$r_done" "$r_total" "$gate" "$maestro" "$(queue_line)"
}

# ── main loop ────────────────────────────────────────────────────────────────
resolve_queue || true
[ "$QUEUE_READY" = 1 ] || echo "[t+0m] (queue progress unavailable — reporting from GitHub checks only)"

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
