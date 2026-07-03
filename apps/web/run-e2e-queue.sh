#!/bin/bash
# ─── Dynamic work-queue runner (NEO-49) ──────────────────────────────────────
# Replaces the static shard partition: a homogeneous pool of CI runners drains
# ONE shared Convex queue (work-stealing). Each runner is its own VM = exactly
# ONE maestro/Chrome (PARALLELISM=1 — web doesn't parallelize within a VM, that
# was the NEO-46 p=2 contention). It bootstraps its worker account, then loops:
#   claim next flow → run it → report pass/fail → repeat, until the queue drains.
# N runners finish together (no slow-shard tail) and the suite scales by just
# adding flows (auto-queued) + runners (more pullers) — no SHARD_TOTAL re-tuning.
#
# Two modes:
#   run-e2e-queue.sh enqueue   # seed the queue with the flow list (run once, in the seed job)
#   run-e2e-queue.sh           # run as a worker: bootstrap + claim-loop
#
# Required env (both modes): CONVEX_SITE_URL, E2E_QUEUE_SECRET, E2E_RUN_ID.
# Worker mode also needs: RUNNER_INDEX (this runner's global worker index → TEST_EMAIL_N), APP_URL.

set -e

MODE="${1:-worker}"

# ── Shared config ────────────────────────────────────────────────────────────
: "${CONVEX_SITE_URL:?CONVEX_SITE_URL (preview .convex.site) is required}"
: "${E2E_QUEUE_SECRET:?E2E_QUEUE_SECRET is required}"
: "${E2E_RUN_ID:?E2E_RUN_ID (queue scope, e.g. GITHUB_RUN_ID) is required}"

# ── Queue HTTP helpers ───────────────────────────────────────────────────────
# The secret is sent ONLY as a header (never echoed, never in Maestro -e). set +x
# defensively so a future `set -x` can't leak the curl line.
_q() { # _q <path> <json-body>  → echoes the response body, exits nonzero on HTTP error
  { set +x; } 2>/dev/null
  curl -fsS -X POST "${CONVEX_SITE_URL}/e2e/$1" \
    -H "x-e2e-queue-secret: ${E2E_QUEUE_SECRET}" \
    -H "Content-Type: application/json" \
    -d "$2"
}

queue_status() { _q status "{\"runId\":\"${E2E_RUN_ID}\"}"; }

# ── ENQUEUE mode: enumerate runnable flows and seed the queue ────────────────
if [ "$MODE" = "enqueue" ]; then
  # Same selection as the suite: every *.yaml under .maestro/flows except util /
  # wip / setup (setup is the pre-matrix seed, never queued as a worker flow).
  flow_has_tag() {
    awk -v want="$2" '
      /^---$/ { exit }
      /^tags:/ { intags=1; next }
      intags && /^[[:space:]]+-[[:space:]]+/ { t=$0; sub(/^[[:space:]]+-[[:space:]]+/,"",t); sub(/[[:space:]]+$/,"",t); if (t==want) {found=1; exit} ; next }
      intags && !/^[[:space:]]/ { intags=0 }
      END { exit(found?0:1) }
    ' "$1"
  }
  FLOWS=()
  while IFS= read -r f; do
    flow_has_tag "$f" util  && continue
    flow_has_tag "$f" wip   && continue
    flow_has_tag "$f" setup && continue
    FLOWS+=("$f")
  done < <(find .maestro/flows/ -name "*.yaml" | sort)

  if [ ${#FLOWS[@]} -eq 0 ]; then echo "No flows to enqueue." >&2; exit 1; fi

  # ── LPT ordering (NEO-61): seed LONGEST-PROCESSING-TIME-FIRST ────────────────
  # The queue claims in INSERTION order (convex/e2eQueue.ts claimNext → .first() on
  # by_run_status), so enqueuing the biggest flows first lets the work-stealing pool
  # start the long poles immediately and balances the runner tail — alphabetical
  # seeding left a ~4.5 min fastest↔slowest spread (e2e-sample-run2). Durations come
  # from .maestro/flow-timings.tsv (auto-regenerated each run by gen-flow-timings.sh).
  # A flow absent from the table (new/unmeasured) gets the MEDIAN of known values →
  # mid-queue, never starved last. Missing/empty table → keep the alphabetical order
  # above (so a deleted/empty table can never break enqueue). bash 3.2-safe (no
  # mapfile) for local parity with macOS.
  TIMINGS_TSV=".maestro/flow-timings.tsv"
  if [ -s "$TIMINGS_TSV" ] && grep -qvE '^#|^[[:space:]]*$' "$TIMINGS_TSV"; then
    reordered=()
    while IFS= read -r f; do reordered+=("$f"); done < <(printf '%s\n' "${FLOWS[@]}" | python3 -c '
import sys
dur = {}
with open(".maestro/flow-timings.tsv") as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            try:
                dur[parts[1]] = float(parts[0])
            except ValueError:
                pass
vals = sorted(dur.values())
if vals:
    n = len(vals)
    median = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2.0
else:
    median = 0.0
flows = [l.strip() for l in sys.stdin if l.strip()]
flows.sort(key=lambda f: (-dur.get(f, median), f))  # seconds desc, path asc
print("\n".join(flows))
')
    FLOWS=("${reordered[@]}")
    echo "Enqueue order: LPT (longest-first) via ${TIMINGS_TSV}" >&2
  else
    echo "Enqueue order: alphabetical (${TIMINGS_TSV} missing/empty)" >&2
  fi

  # Dry-run hook (local verification / CI debugging): print the resolved order and
  # stop before touching the queue. Never set in the seed job.
  if [ -n "${E2E_ENQUEUE_PRINT_ONLY:-}" ]; then
    printf '%s\n' "${FLOWS[@]}"
    exit 0
  fi

  # Build a JSON string array of the flow paths (now in LPT order).
  json_flows=$(printf '%s\n' "${FLOWS[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
  resp=$(_q seed "{\"runId\":\"${E2E_RUN_ID}\",\"flows\":${json_flows}}")
  echo "Enqueued ${#FLOWS[@]} flow(s) (LPT order): ${resp}"
  exit 0
fi

# ── WORKER mode ──────────────────────────────────────────────────────────────
: "${RUNNER_INDEX:?RUNNER_INDEX is required - this runner global worker index}"
: "${APP_URL:?APP_URL is required}"

# Load .env.test without overriding already-set vars (mirror run-e2e-smoke.sh).
if [ -f .env.test ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; [ -z "$key" ] && continue
    if [ -z "${!key+x}" ]; then
      value="${line#*=}"
      case "$value" in \"*\") value="${value#\"}"; value="${value%\"}" ;; \'*\') value="${value#\'}"; value="${value%\'}" ;; esac
      export "$key=$value"
    fi
  done < .env.test
fi

MAESTRO="$HOME/.maestro/bin/maestro"
CONFIG=".maestro/config.yaml"
# TEST_USERNAME is generated FRESH PER FLOW RUN inside run_flow (below), NOT once
# here. This is a persistent daemon worker that runs the same flow many times, so
# a username fixed at worker-start would collide ("Username already taken") on the
# 2nd run. CI (run-e2e-smoke.sh) is one-shot, so it can set one per run; the
# per-run-fresh equivalent on a daemon is per-flow generation. (Profile username
# regex is ^[a-z0-9-]+$ — no underscores; an env-leaked email breaks it.)
REPORT_DIR="${REPORT_DIR:-maestro-report}"
FLOW_TIMEOUT_SEC="${MAESTRO_FLOW_TIMEOUT_SEC:-600}"
mkdir -p "$REPORT_DIR/junit" "$REPORT_DIR/artifacts" "$REPORT_DIR/debug" "$REPORT_DIR/logs" "$REPORT_DIR/maestro-home"

if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else TIMEOUT_CMD=""; fi

# WORKER_INDEX drives TEST_EMAIL_${WORKER_INDEX} inside flows (global index).
WORKER_INDEX="$RUNNER_INDEX"
RUNNER_ID="r${RUNNER_INDEX}"
LOG="$REPORT_DIR/logs/runner-${RUNNER_INDEX}.log"
RESULTS="$REPORT_DIR/logs/runner-${RUNNER_INDEX}.results"
: > "$LOG"; : > "$RESULTS"
export MAESTRO_OPTS="-Duser.home=$PWD/$REPORT_DIR/maestro-home"

ARGS_BASE=(--platform web --config "$CONFIG" -e "APP_URL=$APP_URL" -e "WORKER_INDEX=$WORKER_INDEX")
if [ "${MAESTRO_HEADLESS:-1}" != "0" ]; then ARGS_BASE+=(--headless); fi

# run_flow <flow> → echoes PASS|FAIL ; writes per-flow junit + debug.
# NEO-39: per-flow retry is OFF (MAESTRO_FLOW_RETRIES:-1). The blanket retry was
# masking real flow instability — a first-attempt failure that passed on re-run
# still went green. Forensics traced the sole remaining attempt-1 flake to
# credentials-lifecycle's clear-confirm being stolen by the sticky header; that
# confirm is now a centered modal, so the suite should pass on the FIRST attempt
# (the definition-of-done). Set MAESTRO_FLOW_RETRIES=2+ only to triage a genuine
# Maestro/JVM infra crash.
run_flow() {
  local flow="$1"
  local slug; slug=$(echo "$flow" | sed -e 's|^\.maestro/flows/||' -e 's|/|_|g' -e 's|\.yaml$||')
  local report_args=(--format JUNIT --output "$REPORT_DIR/junit/$slug.xml" --test-suite-name "$slug"
    --test-output-dir "$REPORT_DIR/artifacts/$slug" --debug-output "$REPORT_DIR/debug/$slug" --flatten-debug-output)
  local exit_code attempt=1 max_attempts="${MAESTRO_FLOW_RETRIES:-1}" crash_used=0
  while [ "$attempt" -le "$max_attempts" ]; do
    exit_code=0
    [ "$attempt" -gt 1 ] && echo "↻ [$RUNNER_ID] retry $attempt: $flow" >> "$LOG"
    local attempt_id="${RUNNER_ID}-a${attempt}-${RANDOM}"
    # Fresh username per run (unique across runners, runs, and attempts) so a
    # re-run on this persistent worker never hits "Username already taken". The
    # per-flow analog of CI's per-one-shot-run neontester-$(date +%s). Regex
    # ^[a-z0-9-]+$ — all-lowercase, digits, hyphens only.
    local test_username="neontester-${RUNNER_ID}-$(date +%s)-${RANDOM}"
    local args=("${ARGS_BASE[@]}" -e "ATTEMPT_ID=$attempt_id" -e "TEST_USERNAME=$test_username")
    if [ -n "$TIMEOUT_CMD" ]; then
      "$TIMEOUT_CMD" --kill-after=30 "$FLOW_TIMEOUT_SEC" "$MAESTRO" test "${args[@]}" "${report_args[@]}" "$flow" >> "$LOG" 2>&1 || exit_code=$?
    else
      "$MAESTRO" test "${args[@]}" "${report_args[@]}" "$flow" >> "$LOG" 2>&1 || exit_code=$?
    fi
    [ "$exit_code" -eq 0 ] && break
    { [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ]; } && break  # don't retry timeouts
    # CRASH-ONLY retry (NEO-81 iter6): the maestro-web CDP driver intermittently
    # dies with a ClassCastException (null -> kotlin.Int, maestro issue #2944);
    # the per-flow junit records <failure>Unknown error</failure>. That is an
    # INFRA crash, not a test failure, and no IN-flow retry can catch it — the
    # driver itself died (proven run 28656410552 r5: sets-base, 4s, crashed
    # inside the opener retry). Grant ONE extra attempt. An ASSERTION failure
    # ("Assertion is false" / "No visible element found") is a REAL bug and is
    # NEVER retried — it must stay visible. Discriminator = the junit <failure>
    # MESSAGE (status="ERROR" is set for BOTH crashes and assertions, so it is
    # NOT usable; only the message text distinguishes them).
    if [ "$attempt" -ge "$max_attempts" ] && [ "$crash_used" -eq 0 ] \
       && grep -qE '<failure[^>]*>[[:space:]]*Unknown error' "$REPORT_DIR/junit/$slug.xml" 2>/dev/null \
       && ! grep -qE 'Assertion is false|No visible element found' "$REPORT_DIR/junit/$slug.xml" 2>/dev/null; then
      crash_used=1
      max_attempts=$((max_attempts + 1))
      echo "↻ [$RUNNER_ID] crash-retry (maestro-web CDP driver crash #2944; flaky-crash-retried): $flow" >> "$LOG"
    fi
    attempt=$((attempt + 1))
  done
  if [ "$exit_code" -eq 0 ]; then echo "PASS $flow" >> "$RESULTS"; echo "passed"
  else echo "FAIL $flow" >> "$RESULTS"; echo "failed"; fi
}

# ── Phase 0: bootstrap THIS worker (mandatory — sign-in + reset + seed creds;
#    the marketplace warm inside is best-effort per NEO-46) ───────────────────
echo "Phase 0: bootstrap runner $RUNNER_INDEX (TEST_EMAIL_$WORKER_INDEX)" | tee -a "$LOG"
if [ -z "${MAESTRO_SKIP_BOOTSTRAP:-}" ]; then
  bs="$(run_flow .maestro/flows/profile/worker-bootstrap.yaml)"
  if [ "$bs" != "passed" ]; then
    echo "ERROR: bootstrap failed on runner $RUNNER_INDEX — aborting (creds unseeded)." >&2
    cat "$LOG"; exit 1
  fi
fi

# ── Claim loop: pull → run → report, until the queue drains ──────────────────
# DAEMON MODE (local only, E2E_QUEUE_DAEMON set): instead of EXITING when the
# queue drains, sleep and keep polling so flows enqueued later (./e2e-enqueue.sh)
# get picked up — a persistent worker. CI never sets it, so its behavior is
# unchanged (drain → exit). E2E_QUEUE_STOP_FILE (if set) or SIGINT/SIGTERM stop
# the daemon cleanly after the current flow.
DAEMON="${E2E_QUEUE_DAEMON:-}"
POLL_INTERVAL="${E2E_QUEUE_POLL_INTERVAL:-5}"
STOP_FILE="${E2E_QUEUE_STOP_FILE:-}"
stop=0
trap 'stop=1' INT TERM
echo "Draining queue (runId=$E2E_RUN_ID) as $RUNNER_ID${DAEMON:+ [daemon]} ..." | tee -a "$LOG"
ran=0
while [ "$stop" -eq 0 ]; do
  if [ -n "$STOP_FILE" ] && [ -f "$STOP_FILE" ]; then echo "[$RUNNER_ID] stop sentinel" >> "$LOG"; break; fi
  resp="$(_q claim "{\"runId\":\"${E2E_RUN_ID}\",\"claimedBy\":\"${RUNNER_ID}\",\"leaseMs\":900000}")" || {
    echo "claim failed: $resp" >&2
    [ -n "$DAEMON" ] && { sleep "$POLL_INTERVAL"; continue; }
    exit 1
  }
  flow="$(printf '%s' "$resp" | python3 -c "import sys,json; v=json.load(sys.stdin).get('flowPath'); print(v if v else '')")"
  if [ -z "$flow" ]; then
    [ -n "$DAEMON" ] && { sleep "$POLL_INTERVAL"; continue; }
    break   # queue drained → exit (CI behavior)
  fi
  echo "▶ [$RUNNER_ID] $flow" >> "$LOG"
  status="$(run_flow "$flow")"
  _q result "{\"runId\":\"${E2E_RUN_ID}\",\"flowPath\":\"${flow}\",\"status\":\"${status}\"}" >/dev/null || echo "WARN: result post failed for $flow" >&2
  ran=$((ran + 1))
  mark='❌'; [ "$status" = passed ] && mark='✅'
  echo "$mark [$RUNNER_ID] $status: $flow" >> "$LOG"
done

echo "━━━━━━ Runner $RUNNER_INDEX log ━━━━━━"; cat "$LOG"
echo "Runner $RUNNER_INDEX ran $ran flow(s). Per-flow results recorded in the queue; the 'e2e' gate reads queue status."
exit 0
