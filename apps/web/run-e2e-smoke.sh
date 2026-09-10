#!/bin/bash
# Runs E2E flows across N parallel workers.
#
# This is the LOCAL runner. CI drives the suite through run-e2e-queue.sh
# (NEO-49's work queue) — the one thing CI does use this script for is the
# pre-matrix `setup` seed (`npm run test:e2e -- setup`).
#
# Ordering model: there is none beyond the seed. Run `test:e2e -- setup` to
# seed the deployment, then run whatever flows you want. Flows are otherwise
# self-contained and parallel-safe. (NEO-260 deleted the `requires:`/`provides:`
# dependency graph that used to live here — no flow had carried one since
# NEO-49 replaced the model with the work queue.)
#
# Two serialisation lanes survive, both driven by a tag in a flow's `tags:`
# block. No flow carries either today; the machinery is kept because it is the
# only local guard against the conflicts it describes:
#
#   - `isolated:true` (or legacy `serial-global`) — flow mutates global Convex
#     tables (selectorOptions / cardChecklist / players / teams), e.g. it runs
#     after the scripted Set Builder reset (`e2e-baseline.sh reset` — NEO-214;
#     no more "Reset Set Builder Data" button) or otherwise touches
#     cross-user data. These flows serialize alone on a dedicated worker.
#
#   - `serial-marketplace` — flow hits /login/bsc or /login/sportlots on the
#     browser service. The browser service returns 503 on concurrent
#     marketplace logins, so these serialize on a dedicated worker. They CAN
#     run concurrently with isolated — they only conflict with each other.
#
# Untagged flows are parallel-safe and distributed round-robin across workers.
#
# Execution model (concurrent across all workers):
#     - Lane I: isolated flows        (serial on dedicated worker)
#     - Lane M: marketplace flows     (serial on dedicated worker)
#     - Lane P: independent flows     (parallel, distributed)
#
# Each worker passes WORKER_INDEX through to flows; flows append
# &worker=${WORKER_INDEX} to their /testing/sign-in URLs so the testing
# endpoint resolves TEST_EMAIL_${worker} / NEW_PROFILE_TEST_EMAIL_${worker}.
#
# Usage:
#   ./run-e2e-smoke.sh                           # all flows, default parallelism
#   ./run-e2e-smoke.sh smoke                     # only flows tagged "smoke"
#   MAESTRO_PARALLELISM=1 ./run-e2e-smoke.sh     # serial fallback (debugging)
#   MAESTRO_PARALLELISM=4 ./run-e2e-smoke.sh     # 4 workers

set -e

# Load .env.test if it exists — but don't override vars already set in the
# calling environment. `set -a; source` would overwrite, so read line-by-line
# and only export when the key is unset.
if [ -f .env.test ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    [ -z "$key" ] && continue
    if [ -z "${!key+x}" ]; then
      value="${line#*=}"
      # Strip matching surrounding quotes
      case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
      esac
      export "$key=$value"
    fi
  done < .env.test
fi

MAESTRO="$HOME/.maestro/bin/maestro"
CONFIG=".maestro/config.yaml"

# Chrome for Testing is MANDATORY locally (NEO-138). Branded Google Chrome
# exposes chrome://omnibox-popup CDP targets ahead of the real tab, and Maestro
# — whose CdpTarget model has no `type` field to filter on — drives the popup
# widget instead, giving every flow a 1x1 viewport (heightPixels=1) and 1x1
# failure screenshots. No-op in CI, where setup-chrome already installs a
# non-branded build. See lib-e2e-chrome.sh for the full write-up.
source "$(dirname "${BASH_SOURCE[0]}")/lib-e2e-chrome.sh"
require_chrome_for_testing || exit 1
[ -n "$SE_BROWSER_PATH" ] && echo "🌐 Chrome: $SE_BROWSER_PATH"

# Plain HTTP, matching CI exactly: the maestro-runner action stands up a Node
# http.createServer proxy on localhost:3000 forwarding to the Vercel preview, so
# every green CI run has always driven `http://localhost:3000`.
#
# This used to default to https://localhost:3000 (vite-plugin-mkcert) — the one
# part of the local setup that diverged from CI, and it broke every local flow.
# Against the mkcert HTTPS server, Chrome for Testing hangs after `launchApp`
# and Selenium's getCurrentUrl blocks until its 180s timeout:
#   CommandFailed: Timeout when executing request (GET .../url)
# with a blank (but correctly sized, 1024x625) screenshot — which reads exactly
# like a product bug. Same browser, same driver, same flow over HTTP passes in
# 19s. Branded Chrome appears to cope only because it is a long-lived profile;
# chromedriver hands Chrome for Testing a fresh --user-data-dir every run.
#
# http://localhost is a secure context per spec, so Clerk, crypto.subtle and
# service workers behave exactly as they do under TLS. vite-keeper.sh sets
# VITE_DEV_DISABLE_HTTPS=1 so the server it starts matches this default.
APP_URL="${APP_URL:-http://localhost:3000}"
# Unique username per run to avoid "already taken" in profile flows.
# Must match the profile validation regex ^[a-z0-9-]+$ (no underscores).
TEST_USERNAME="${TEST_USERNAME:-neontester-$(date +%s)}"
# NOTE: NO marketplace credentials (or any other secret) are passed to Maestro
# via -e. Maestro serializes the full -e env map into its debug artifacts
# (commands-*.json / maestro.log), so any secret there leaks into the public CI
# artifact (NEO-29). Instead, flows route their sign-in through /testing/reset
# (auth-scoped resetMyTestState) and /testing/seed-credentials (auth-scoped
# seedMyTestCredentials), which seed the dev user's BSC/SportLots creds from
# Convex server env vars — the secrets never touch Maestro.
# Per-flow JUnit + screenshot artifacts land here; the CI workflow publishes them
# as a PR check (JUnit) and uploads the directory as an Actions artifact.
REPORT_DIR="${REPORT_DIR:-maestro-report}"
mkdir -p "$REPORT_DIR/junit" "$REPORT_DIR/artifacts" "$REPORT_DIR/logs" "$REPORT_DIR/debug"
# Per-flow hard timeout (seconds). Maestro 2.2.0 has a Jackson/Kotlin reflection
# bug (FasterXML/jackson-module-kotlin#296) that can hang the JVM indefinitely
# while writing debug output after a failed flow — the exception kills `main`
# but a non-daemon heartbeat thread keeps the JVM alive. Without this wrapper,
# one hung flow blocks every other worker. Use `gtimeout` (GNU coreutils) on
# macOS, plain `timeout` on Linux/CI. Override with MAESTRO_FLOW_TIMEOUT_SEC.
FLOW_TIMEOUT_SEC="${MAESTRO_FLOW_TIMEOUT_SEC:-600}"
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  echo "WARNING: no gtimeout/timeout command available — a hung maestro JVM will block the suite." >&2
  TIMEOUT_CMD=""
fi
# Per-worker JVM "user.home" override. Maestro's DebugLogStore writes to
# {user.home}/Library/Logs/maestro/{timestamp}/ and tries to zip+remove it on
# exit — concurrent workers race in that shared dir and one process hangs in
# DebugLogStore.finalizeRun with NoSuchFileException. Giving each worker its
# own user.home (via MAESTRO_OPTS=-Duser.home=...) isolates the log dirs so
# no two maestro JVMs ever touch the same path. The maestro wrapper script
# locates its own install via $HOME (env var, not user.home), so it still
# finds ~/.maestro/lib/ correctly.
rm -rf "$REPORT_DIR/maestro-home"
mkdir -p "$REPORT_DIR/maestro-home"

# Truncate per-worker log/results files up-front so Phase 0 output is
# preserved through Phases 1 and 2 (the lane runners now append rather than
# truncate). Truncate up to a generous worker count — extra files just stay
# empty and the final dump skips them by existence check.
for ((w = 0; w < 16; w++)); do
  : > "$REPORT_DIR/logs/worker-${w}.log"
  : > "$REPORT_DIR/logs/worker-${w}.results"
done

# Parallelism. Default 3; clamp to >=1.
PARALLELISM="${MAESTRO_PARALLELISM:-3}"
if ! [[ "$PARALLELISM" =~ ^[0-9]+$ ]] || [ "$PARALLELISM" -lt 1 ]; then
  PARALLELISM=1
fi

# ─── Sharding (NEO-46) ──────────────────────────────────────────────────────
# Scale the suite across multiple CI runners. Each "shard" is one runner that
# runs PARALLELISM workers; SHARD_TOTAL shards together cover the whole suite.
# Defaults (SHARD_INDEX=0, SHARD_TOTAL=1) reproduce single-runner behavior
# byte-for-byte — every shard-aware branch below is gated on SHARD_TOTAL > 1.
#
#   - The serial backbone (isolated + marketplace) runs ONLY on shard 0; other
#     shards run a deterministic slice of the parallel-safe "independent" flows
#     (see the shard partition after categorization).
#   - Workers carry a GLOBAL index (local worker + WORKER_INDEX_BASE) so two
#     shards never sign in as the same TEST_EMAIL_${N} Clerk user and clobber
#     each other. Log / results / maestro-home dirs stay keyed by the LOCAL index.
SHARD_INDEX="${SHARD_INDEX:-0}"
SHARD_TOTAL="${SHARD_TOTAL:-1}"
if ! [[ "$SHARD_TOTAL" =~ ^[0-9]+$ ]] || [ "$SHARD_TOTAL" -lt 1 ]; then
  SHARD_TOTAL=1
fi
if ! [[ "$SHARD_INDEX" =~ ^[0-9]+$ ]] || [ "$SHARD_INDEX" -ge "$SHARD_TOTAL" ]; then
  SHARD_INDEX=0
fi
WORKER_INDEX_BASE="${WORKER_INDEX_BASE:-$((SHARD_INDEX * PARALLELISM))}"

# --platform web required so launchApp navigates to each flow's url:
# (config cannot set platform). WORKER_INDEX is appended per-worker below.
# Headless by default. Set MAESTRO_HEADLESS=0 to watch the browser run.
ARGS_BASE=(--platform web --config "$CONFIG" -e "APP_URL=$APP_URL" -e "TEST_USERNAME=$TEST_USERNAME")
if [ "${MAESTRO_HEADLESS:-1}" != "0" ]; then
  ARGS_BASE+=(--headless)
fi

# ─── Flow selection & discovery ─────────────────────────────────────────────
# The first positional arg selects WHICH flows to run. Backwards-compatible:
# an empty arg runs everything; a bare word (no ':' ',' '/') is a TAG, exactly
# as before — so `smoke` / `regression` are unchanged. New explicit forms let
# you run just a piece of the suite without editing the script:
#
#   (empty)                    all flows (minus util/wip)            [unchanged]
#   smoke                      flows tagged "smoke"                  [unchanged]
#   tag:regression             flows tagged "regression"            (explicit tag)
#   name:set-features-panel    flows whose PATH contains the substring
#   name:features,team-picker  comma list of substrings (OR-matched)
#   set-features,team-picker   bare comma list (implies name match)
#   grep:cards-.*custom        case-insensitive regex over flow paths
#   /cards-.*custom/           regex, slash-wrapped shorthand
#
# `util` flows (reusable fragments invoked via runFlow; they assume the caller
# already did launchApp+sign-in, so they fail standalone) are never selected.
# `wip` flows are excluded from broad selection (all / tag / grep) but CAN be
# hit by an explicit `name:` match so you can iterate on one you're un-wip-ing.
#
# Selection pulls in nothing else: what you name is what runs. Seed the
# deployment first with `npm run test:e2e -- setup` if the flows you picked
# need data. Controls:
#   MAESTRO_SKIP_BOOTSTRAP=1 skip the Phase 0 per-worker credential bootstrap
#                            (use only when worker creds are already seeded).

# flow_tags <flow.yaml> — emits one tag per line (the text after `- ` in the
# top-level `tags:` block, before the `---` separator).
flow_tags() {
  awk '
    /^---$/ { exit }
    /^tags:/ { intags=1; next }
    intags && /^[[:space:]]+-[[:space:]]+/ {
      sub(/^[[:space:]]+-[[:space:]]+/, "")
      sub(/[[:space:]]+$/, "")
      print
      next
    }
    intags && !/^[[:space:]]/ { intags=0 }
  ' "$1"
}
flow_has_tag()        { flow_tags "$1" | grep -qxF "$2"; }

SELECTOR="${1:-}"
TAG=""                 # set only in tag mode (drives summary/comment text)
SELECT_MODE="all"      # all | tag | name | grep
PATTERNS=()            # name substrings (OR) or a single regex
case "$SELECTOR" in
  "")      SELECT_MODE="all" ;;
  setup)   SELECT_MODE="setup" ;;   # pre-matrix seed: the global setup track only
  tag:*)   SELECT_MODE="tag";  TAG="${SELECTOR#tag:}" ;;
  name:*)  SELECT_MODE="name"; IFS=',' read -ra PATTERNS <<< "${SELECTOR#name:}" ;;
  grep:*)  SELECT_MODE="grep"; PATTERNS=("${SELECTOR#grep:}") ;;
  /*/)     SELECT_MODE="grep"; re_body="${SELECTOR#/}"; PATTERNS=("${re_body%/}") ;;
  *,*)     SELECT_MODE="name"; IFS=',' read -ra PATTERNS <<< "$SELECTOR" ;;
  *)       SELECT_MODE="tag";  TAG="$SELECTOR" ;;
esac

SELECTED_FLOWS=()
case "$SELECT_MODE" in
  all)
    while IFS= read -r f; do
      flow_has_tag "$f" util && continue
      flow_has_tag "$f" wip && continue
      flow_has_tag "$f" setup && continue   # NEO-46: setup runs in the pre-matrix CI job, never as a thread
      SELECTED_FLOWS+=("$f")
    done < <(find .maestro/flows/ -name "*.yaml" | sort)
    ;;
  tag)
    while IFS= read -r f; do
      flow_has_tag "$f" util && continue
      flow_has_tag "$f" setup && continue   # NEO-46: setup is seeded pre-matrix, not run as a thread
      SELECTED_FLOWS+=("$f")
    done < <(grep -rlE "^[[:space:]]*-[[:space:]]+${TAG}$" .maestro/flows/ --include="*.yaml" | sort)
    ;;
  name)
    while IFS= read -r f; do
      flow_has_tag "$f" util && continue
      for pat in "${PATTERNS[@]}"; do
        [ -z "$pat" ] && continue
        case "$f" in *"$pat"*) SELECTED_FLOWS+=("$f"); break ;; esac
      done
    done < <(find .maestro/flows/ -name "*.yaml" | sort)
    ;;
  grep)
    while IFS= read -r f; do
      flow_has_tag "$f" util && continue
      flow_has_tag "$f" wip && continue
      flow_has_tag "$f" setup && continue   # NEO-46: setup runs pre-matrix, not as a thread
      SELECTED_FLOWS+=("$f")
    done < <(find .maestro/flows/ -name "*.yaml" | grep -iE "${PATTERNS[0]}" | sort)
    ;;
  setup)
    # NEO-46 pre-matrix seed: this is the ONLY entry point that runs the
    # setup-tagged flows (every other mode excludes them — they are seeded once,
    # before the shard matrix fans out, never as a thread). The CI `seed` job
    # invokes this against the shared per-PR Convex preview so the global
    # baseline (selectorOptions / cardChecklist / players / teams) is present
    # before any shard's flows run.
    # NEO-62 (Lever 1): collapsed from 3 flows to 1. setup.yaml now handles
    # Base + Insert + Parallel in a single browser context — no restarts,
    # no re-drills, no re-logins.
    for f in \
      .maestro/flows/setup.yaml; do
      [ -f "$f" ] && SELECTED_FLOWS+=("$f")
    done
    ;;
esac

# The setup track is a single-writer seed (global reset → base → insert →
# parallel, all in one browser context). Force serial worker-0 regardless of
# caller parallelism.
if [ "$SELECT_MODE" = "setup" ]; then
  PARALLELISM=1
fi

if [ ${#SELECTED_FLOWS[@]} -eq 0 ]; then
  echo "No flows matched selector \"${SELECTOR}\" in .maestro/flows/"
  exit 0
fi

# Final SMOKE_FLOWS = sorted-unique selected set — EXCEPT the setup track
# (NEO-62: now a single setup.yaml), which bypasses sort -u so it stays first.
SMOKE_FLOWS=()
if [ "$SELECT_MODE" = "setup" ]; then
  SMOKE_FLOWS=("${SELECTED_FLOWS[@]}")
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    SMOKE_FLOWS+=("$f")
  done < <(printf '%s\n' "${SELECTED_FLOWS[@]}" | sort -u)
fi

# ─── Tag parsing & categorization ───────────────────────────────────────────

# Parallel indexed array keyed by SMOKE_FLOWS position. Bash 3.2 compatible
# (macOS ships 3.2; no associative arrays).
FLOW_CATEGORY_LIST=()   # isolated | marketplace | independent

for i in "${!SMOKE_FLOWS[@]}"; do
  flow="${SMOKE_FLOWS[$i]}"
  is_isolated=false
  is_marketplace=false
  while IFS= read -r tag; do
    case "$tag" in
      isolated|isolated:true) is_isolated=true ;;
      serial-global)      is_isolated=true ;;   # legacy alias for backwards compat
      serial-marketplace) is_marketplace=true ;;
    esac
  done < <(flow_tags "$flow")

  if $is_isolated; then
    FLOW_CATEGORY_LIST[$i]="isolated"
  elif $is_marketplace; then
    FLOW_CATEGORY_LIST[$i]="marketplace"
  else
    FLOW_CATEGORY_LIST[$i]="independent"
  fi
done

# Bucket flows by category. We keep these as flow paths (not indices) for
# easy iteration in the lane runners.
ISOLATED_FLOWS=()
MARKETPLACE_FLOWS=()
INDEPENDENT_FLOWS=()
for i in "${!SMOKE_FLOWS[@]}"; do
  case "${FLOW_CATEGORY_LIST[$i]}" in
    isolated)    ISOLATED_FLOWS+=("${SMOKE_FLOWS[$i]}") ;;
    marketplace) MARKETPLACE_FLOWS+=("${SMOKE_FLOWS[$i]}") ;;
    independent) INDEPENDENT_FLOWS+=("${SMOKE_FLOWS[$i]}") ;;
  esac
done

# ─── Shard partition (NEO-46) ───────────────────────────────────────────────
# Trim the categorized buckets to this shard's slice. No-op when SHARD_TOTAL=1.
#
#   - Serial backbone (isolated / marketplace) is shard-0-only: non-zero shards
#     empty those buckets so they run no serial-lane work.
#   - Independent flows are split across shards. Phase-A conservatism: only
#     clearly global-free dirs (auth / dashboard / home / profile) are
#     distributed; set-selector/ independents may implicitly read global
#     selectorOptions mid-reset, so they stay pinned to shard 0 until the
#     Phase-B audit reclassifies them. The distributable list is sorted-stable
#     (SMOKE_FLOWS is `sort -u`), so a plain `i % SHARD_TOTAL` makes every shard
#     agree on a disjoint, exhaustive partition.
is_distributable_flow() {
  # NEO-46 flat model: every INDEPENDENT flow is parallel-safe by construction
  # (per-worker custom subtrees, or read-only on the pre-seeded baseline), so the
  # whole independent set splits across shards by `i % SHARD_TOTAL`. The only
  # serial backbone left is the marketplace lane (shard-0-only), and those flows
  # are category=marketplace, not independent — they never reach this function.
  return 0
}

if [ "$SHARD_TOTAL" -gt 1 ]; then
  if [ "$SHARD_INDEX" -ne 0 ]; then
    ISOLATED_FLOWS=()
    MARKETPLACE_FLOWS=()
  fi

  shard_distributable=()
  shard_pinned=()
  for f in "${INDEPENDENT_FLOWS[@]}"; do
    if is_distributable_flow "$f"; then
      shard_distributable+=("$f")
    else
      shard_pinned+=("$f")
    fi
  done

  new_independent=()
  # Shard 0 also keeps the non-distributable independents (set-selector/, etc.).
  if [ "$SHARD_INDEX" -eq 0 ] && [ ${#shard_pinned[@]} -gt 0 ]; then
    new_independent+=("${shard_pinned[@]}")
  fi
  # Every shard takes its modulo slice of the distributable flows.
  for di in "${!shard_distributable[@]}"; do
    if [ $(( di % SHARD_TOTAL )) -eq "$SHARD_INDEX" ]; then
      new_independent+=("${shard_distributable[$di]}")
    fi
  done

  INDEPENDENT_FLOWS=()
  if [ ${#new_independent[@]} -gt 0 ]; then
    INDEPENDENT_FLOWS=("${new_independent[@]}")
  fi
fi

# ─── Plan summary ───────────────────────────────────────────────────────────
case "$SELECT_MODE" in
  all)   sel_label="all flows" ;;
  setup) sel_label="setup track (pre-matrix seed)" ;;
  tag)   sel_label="tag \"$TAG\"" ;;
  name)  sel_label="name ~ ${PATTERNS[*]}" ;;
  grep)  sel_label="grep /${PATTERNS[0]}/" ;;
esac
echo "Selector: ${SELECTOR:-(none)}  →  ${sel_label}"
echo "Found ${#SMOKE_FLOWS[@]} flow(s)${TAG:+ tagged \"$TAG\"}"
echo "  Isolated:    ${#ISOLATED_FLOWS[@]}"
echo "  Marketplace: ${#MARKETPLACE_FLOWS[@]}"
echo "  Independent: ${#INDEPENDENT_FLOWS[@]}"
echo "Parallelism: $PARALLELISM worker(s)"
if [ "$SHARD_TOTAL" -gt 1 ]; then
  echo "Shard: $SHARD_INDEX of $SHARD_TOTAL (global worker base $WORKER_INDEX_BASE → TEST_EMAIL_$WORKER_INDEX_BASE..$((WORKER_INDEX_BASE + PARALLELISM - 1)))"
fi
if [ ${#ISOLATED_FLOWS[@]} -gt 0 ]; then
  echo "  Isolated lane:"
  for f in "${ISOLATED_FLOWS[@]}"; do echo "    $f"; done
fi
if [ ${#MARKETPLACE_FLOWS[@]} -gt 0 ]; then
  echo "  Marketplace lane:"
  for f in "${MARKETPLACE_FLOWS[@]}"; do echo "    $f"; done
fi
if [ ${#INDEPENDENT_FLOWS[@]} -gt 0 ]; then
  echo "  Independent lane:"
  for f in "${INDEPENDENT_FLOWS[@]}"; do echo "    $f"; done
fi
echo ""

# Plan-only: print the schedule and exit without launching Maestro. Lets you
# verify a selector before committing to a run.
if [ -n "${MAESTRO_PLAN_ONLY:-}" ]; then
  echo "MAESTRO_PLAN_ONLY set — exiting before execution."
  exit 0
fi

# ─── Scripted reset ahead of the setup track (NEO-214) ──────────────────────
# setup.yaml no longer clicks "Reset Set Builder Data" itself — the Admin
# Tools panel is gone. This is the ONLY place in the setup path that resets:
# `e2e-baseline.sh reset` runs once here, before setup.yaml's own flow (which
# does the Sports sync that creates the Baseball row setup.yaml depends on),
# then setup.yaml runs against the freshly-emptied deployment exactly as
# before. CONVEX_NAME (CI) / --deployment / the .env.local default and the
# CI-vs-interactive confirmation gate are all e2e-baseline.sh's own job — see
# that script. Runs in CI and locally alike; this is the single entry point
# both go through, so they can't drift.
if [ "$SELECT_MODE" = "setup" ]; then
  echo "── setup track: scripted reset before setup.yaml ──"
  ./e2e-baseline.sh reset
fi

# ─── Worker runner ──────────────────────────────────────────────────────────
# run_flow_on_worker <worker_index> <flow>
# Runs a single maestro test, appends its outcome to that worker's results
# file. Idempotent on results — appends one PASS/FAIL line per call.
run_flow_on_worker() {
  local worker_index=$1
  local flow=$2
  local log_file="$REPORT_DIR/logs/worker-${worker_index}.log"
  local results_file="$REPORT_DIR/logs/worker-${worker_index}.results"
  local worker_home="$PWD/$REPORT_DIR/maestro-home/worker-$worker_index"
  mkdir -p "$worker_home"
  export MAESTRO_OPTS="-Duser.home=$worker_home"

  # No secrets are ever passed via -e (NEO-29) — marketplace creds are seeded
  # server-side through /testing/seed-credentials. Only the non-secret worker
  # index is passed here.
  #
  # GLOBAL worker index (NEO-46): flows resolve TEST_EMAIL_${WORKER_INDEX} from
  # this value, so it must be unique across shards or two runners sign in as the
  # same Clerk user and clobber each other. WORKER_INDEX_BASE is 0 in
  # single-shard mode, so global == local there. The local worker_index keeps
  # keying this shard's log / results / maestro-home files below.
  local global_worker=$(( worker_index + WORKER_INDEX_BASE ))
  local worker_args=("${ARGS_BASE[@]}" -e "WORKER_INDEX=$global_worker")

  local slug
  slug=$(echo "$flow" | sed -e 's|^\.maestro/flows/||' -e 's|/|_|g' -e 's|\.yaml$||')
  local report_args=(
    --format JUNIT
    --output "$REPORT_DIR/junit/$slug.xml"
    --test-suite-name "$slug"
    --test-output-dir "$REPORT_DIR/artifacts/$slug"
    --debug-output "$REPORT_DIR/debug/$slug"
    --flatten-debug-output
  )
  # worker_args carries no secrets (NEO-29), so it is safe to log verbatim.
  {
    echo "▶ [w$worker_index] $flow"
    if [ -n "$TIMEOUT_CMD" ]; then
      echo "$TIMEOUT_CMD" --kill-after=30 "$FLOW_TIMEOUT_SEC" "$MAESTRO" test "${worker_args[@]}" "${report_args[@]}" "$flow"
    else
      echo "$MAESTRO" test "${worker_args[@]}" "${report_args[@]}" "$flow"
    fi
  } >> "$log_file"
  # NEO-42: per-flow retry is OFF (MAESTRO_FLOW_RETRIES:-1), matching
  # run-e2e-queue.sh — the runner CI actually drives the flows with. A blanket
  # retry masked real instability: a first-attempt failure that passed on
  # re-run still went green, so the "Passed on retry" flows were never chased
  # down. The reactive-form and coordinate-staleness root causes behind them
  # are fixed (NEO-39/40, NEO-81/85), and first-attempt green is the
  # definition-of-done. Keeping the loop (rather than deleting it) preserves
  # the escape hatch: set MAESTRO_FLOW_RETRIES=2+ to triage a genuine
  # Maestro/JVM infra crash (CDP "null cannot be cast to non-null type
  # kotlin.Int" / "Failed to execute JS", or a mid-flow SIGSEGV/SIGBUS).
  # Never raise the default to get a red suite green — fix the flow.
  # Timeout codes still never retry: those mean a slow/hung product path.
  #
  # This also covers CI's pre-matrix `setup` track (e2e.yml runs
  # `npm run test:e2e -- setup`, which routes setup.yaml through this same
  # function). That is intentional: a setup failure is a config/secrets/env
  # problem — exactly the class a silent re-run hides. Verified inert at the
  # time of the change: the last 3 green pipelines logged zero retry lines.
  local exit_code=0
  local attempt=1
  local max_attempts="${MAESTRO_FLOW_RETRIES:-1}"
  while [ "$attempt" -le "$max_attempts" ]; do
    exit_code=0
    if [ "$attempt" -gt 1 ]; then
      echo "↻ [w$worker_index] Retry attempt $attempt/$max_attempts: $flow" >> "$log_file"
    fi
    # Per-attempt unique ID. Flows that add cards to the global
    # cardChecklist table reference ${ATTEMPT_ID} in their card
    # numbers + player names so attempt 2 doesn't collide with the
    # rows attempt 1 left behind (the scripted `e2e-baseline.sh reset`
    # only runs once per CI run, ahead of setup.yaml, not between
    # in-run retries).
    local attempt_id="w${global_worker}-a${attempt}-${RANDOM}"
    local attempt_args=("${worker_args[@]}" -e "ATTEMPT_ID=$attempt_id")
    if [ -n "$TIMEOUT_CMD" ]; then
      # --kill-after=30: after SIGTERM, give 30s, then SIGKILL — covers the
      # Maestro JVM's non-daemon heartbeat thread that ignores main's exit.
      "$TIMEOUT_CMD" --kill-after=30 "$FLOW_TIMEOUT_SEC" "$MAESTRO" test "${attempt_args[@]}" "${report_args[@]}" "$flow" >> "$log_file" 2>&1 || exit_code=$?
    else
      "$MAESTRO" test "${attempt_args[@]}" "${report_args[@]}" "$flow" >> "$log_file" 2>&1 || exit_code=$?
    fi
    if [ "$exit_code" -eq 0 ]; then
      break
    fi
    # Don't retry on timeout — usually indicates a slow/hung path that
    # won't recover, and the runtime cost of a second attempt is high.
    if [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ]; then
      break
    fi
    attempt=$((attempt + 1))
  done
  if [ "$exit_code" -eq 0 ]; then
    if [ "$attempt" -gt 1 ]; then
      echo "✅ [w$worker_index] Passed on retry: $flow" >> "$log_file"
    else
      echo "✅ [w$worker_index] Passed: $flow" >> "$log_file"
    fi
    echo "PASS $flow" >> "$results_file"
  elif [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ]; then
    # 124 = SIGTERM by timeout; 137 = SIGKILL after grace period.
    echo "⏱  [w$worker_index] TIMEOUT after ${FLOW_TIMEOUT_SEC}s: $flow" >> "$log_file"
    echo "FAIL $flow (timeout)" >> "$results_file"
  else
    if [ "$max_attempts" -gt 1 ]; then
      echo "❌ [w$worker_index] Failed after $max_attempts attempts: $flow" >> "$log_file"
    else
      echo "❌ [w$worker_index] Failed: $flow" >> "$log_file"
    fi
    echo "FAIL $flow" >> "$results_file"
  fi
  echo "" >> "$log_file"
}

# run_serial_lane <worker_index> <flow...>
# Runs a list of flows sequentially on one worker. Appends to the worker's
# log/results files (which are truncated once at script init), so Phase 0
# bootstrap output remains visible alongside Phase 1 / 2 output.
run_serial_lane() {
  local worker_index=$1
  shift
  for flow in "$@"; do
    run_flow_on_worker "$worker_index" "$flow"
  done
}

# ─── Phase 0: per-worker bootstrap ──────────────────────────────────────────
# Each worker signs in as TEST_EMAIL_${WORKER_INDEX} and saves the shared
# BSC + SL credentials under that Clerk user in Secret Manager. Idempotent —
# the underlying setup-bsc-credentials.yaml / setup-sportlots-credentials.yaml
# helpers short-circuit when "Clear Credentials" is visible, so reruns are
# cheap and never trigger a fresh marketplace login (rate-limit risk).
#
# Why this is required: each Maestro worker drives a distinct Clerk test
# user (TEST_EMAIL_${WORKER_INDEX}). Marketplace adapter calls (BSC / SL)
# fetch session tokens from Secret Manager keyed by the Clerk user ID.
# Without per-worker bootstrap, only the worker that ran setup.yaml had
# its credentials saved; other workers' adapter calls hit NOT_FOUND, both
# options arrays return empty, the ReconciliationModal silently never
# opens, and tests time out.
# EVERY worker on EVERY shard warms its own BSC + SL marketplace token ONCE here
# (full bootstrap), then every downstream flow just READS the cached token. This
# is what makes flows shard-independent: a marketplace-touching flow can land on
# any shard because that shard's worker is already warm.
#
# There is NO concurrent-login rate limit on the shared dev BSC/SL accounts
# (confirmed with BSC) — the earlier "light bootstrap on shards 1+" existed only
# to avoid an imaginary "login storm". Each worker logs in exactly once (~N total,
# one per worker); transient/random BSC/SL login failures are covered by the
# adapter retry. If a warm here fails, diagnose it from Cloud Run + Convex +
# PostHog logs (NOT by assuming rate-limiting), because a real login bug must be
# fixed at the source, not masked by a per-flow re-login.
BOOTSTRAP_FLOW=".maestro/flows/profile/worker-bootstrap.yaml"
if [ -n "${MAESTRO_SKIP_BOOTSTRAP:-}" ]; then
  echo "Phase 0: SKIPPED (MAESTRO_SKIP_BOOTSTRAP) — assuming worker creds already seeded."
  echo ""
elif [ -f "$BOOTSTRAP_FLOW" ]; then
  echo "Phase 0: per-worker bootstrap (sign-in + save BSC + SL creds for every worker)"
  # SERIAL by default. Concurrent JVM startup of multiple maestro CLI processes
  # has triggered JIT-compiler SIGSEGVs in kotlin.reflect on JDK 23 / macOS
  # aarch64 (deterministic across runs; different code paths each time).
  # Phase 1/2 parallelism is unaffected — JVMs stagger naturally after the
  # initial Phase 0 ramp. Set MAESTRO_PHASE0_PARALLEL=true to opt back into
  # parallel bootstrap (useful where JVM is stable, e.g. Linux CI runners).
  if [ "${MAESTRO_PHASE0_PARALLEL:-false}" = "true" ]; then
    bootstrap_pids=()
    for w in $(seq 0 $((PARALLELISM - 1))); do
      run_flow_on_worker "$w" "$BOOTSTRAP_FLOW" &
      bootstrap_pids+=($!)
    done
    for pid in "${bootstrap_pids[@]}"; do
      wait "$pid" || true
    done
  else
    for w in $(seq 0 $((PARALLELISM - 1))); do
      run_flow_on_worker "$w" "$BOOTSTRAP_FLOW"
    done
  fi
  # Fail fast if any worker failed to bootstrap — every subsequent flow on
  # that worker would hit Secret Manager NOT_FOUND and time out silently.
  bootstrap_failed=false
  for w in $(seq 0 $((PARALLELISM - 1))); do
    if grep -q "^FAIL $BOOTSTRAP_FLOW" "$REPORT_DIR/logs/worker-${w}.results" 2>/dev/null; then
      echo "ERROR: Phase 0 bootstrap failed on worker $w. See $REPORT_DIR/logs/worker-${w}.log" >&2
      bootstrap_failed=true
    fi
  done
  if $bootstrap_failed; then
    echo "Aborting: bootstrap must succeed on every worker before Phase 1 can run safely." >&2
    exit 1
  fi
  echo "Phase 0 complete."
  echo ""
fi

# ─── Phase 1: static lanes (concurrent) ─────────────────────────────────────
# Lanes claim workers dynamically based on which lanes have any flows. The
# isolated lane gets the lowest worker index (or worker 0 alone if it's the
# only lane); marketplace gets the next; independent uses everything left.
#
# Special case PARALLELISM=1: everything serial on worker 0 in order
# isolated → marketplace → independent.
phase1_pids=()
ISOLATED_PID=""
MARKETPLACE_PID=""
INDEPENDENT_PID=""

if [ "$PARALLELISM" -eq 1 ]; then
  if [ ${#ISOLATED_FLOWS[@]} -gt 0 ];    then run_serial_lane 0 "${ISOLATED_FLOWS[@]}";    fi
  if [ ${#MARKETPLACE_FLOWS[@]} -gt 0 ]; then run_serial_lane 0 "${MARKETPLACE_FLOWS[@]}"; fi
  if [ ${#INDEPENDENT_FLOWS[@]} -gt 0 ]; then run_serial_lane 0 "${INDEPENDENT_FLOWS[@]}"; fi
else
  next_worker=0
  ind_workers=()

  # Lane I: claim a worker
  if [ ${#ISOLATED_FLOWS[@]} -gt 0 ]; then
    isolated_worker=$next_worker
    next_worker=$((next_worker + 1))
    (run_serial_lane "$isolated_worker" "${ISOLATED_FLOWS[@]}") &
    ISOLATED_PID=$!
    phase1_pids+=("$ISOLATED_PID")
  fi

  # Lane M: claim the next worker (if any are left after I)
  if [ ${#MARKETPLACE_FLOWS[@]} -gt 0 ]; then
    if [ "$next_worker" -lt "$PARALLELISM" ]; then
      marketplace_worker=$next_worker
      next_worker=$((next_worker + 1))
    else
      # All workers reserved by I — fall back to running marketplace on the
      # last reserved worker AFTER I finishes.
      marketplace_worker=$((next_worker - 1))
    fi
    if [ "$marketplace_worker" = "$isolated_worker" ] 2>/dev/null && [ -n "$ISOLATED_PID" ]; then
      (wait "$ISOLATED_PID" || true; run_serial_lane "$marketplace_worker" "${MARKETPLACE_FLOWS[@]}") &
    else
      (run_serial_lane "$marketplace_worker" "${MARKETPLACE_FLOWS[@]}") &
    fi
    MARKETPLACE_PID=$!
    phase1_pids+=("$MARKETPLACE_PID")
  fi

  # Lane P: all workers from next_worker..PARALLELISM-1
  if [ ${#INDEPENDENT_FLOWS[@]} -gt 0 ]; then
    for ((w = next_worker; w < PARALLELISM; w++)); do ind_workers+=("$w"); done
    if [ ${#ind_workers[@]} -eq 0 ]; then
      # No free worker — fall back to running independent on the marketplace
      # worker after marketplace finishes (or isolated worker if no marketplace).
      fallback_worker=${marketplace_worker:-${isolated_worker:-0}}
      fallback_pid=${MARKETPLACE_PID:-${ISOLATED_PID:-}}
      if [ -n "$fallback_pid" ]; then
        (wait "$fallback_pid" || true; run_serial_lane "$fallback_worker" "${INDEPENDENT_FLOWS[@]}") &
      else
        (run_serial_lane "$fallback_worker" "${INDEPENDENT_FLOWS[@]}") &
      fi
      INDEPENDENT_PID=$!
      phase1_pids+=("$INDEPENDENT_PID")
    else
      # Stripe round-robin across ind_workers. Log files were truncated once
      # at script init; we append here so prior phases' output is preserved.
      (
        ind_count=${#ind_workers[@]}
        sub_pids=()
        for i in "${!INDEPENDENT_FLOWS[@]}"; do
          w="${ind_workers[$((i % ind_count))]}"
          run_flow_on_worker "$w" "${INDEPENDENT_FLOWS[$i]}" &
          sub_pids+=($!)
          if [ "${#sub_pids[@]}" -ge "$ind_count" ]; then
            wait "${sub_pids[0]}" || true
            sub_pids=("${sub_pids[@]:1}")
          fi
        done
        for pid in "${sub_pids[@]}"; do wait "$pid" || true; done
      ) &
      INDEPENDENT_PID=$!
      phase1_pids+=("$INDEPENDENT_PID")
    fi
  fi
fi

# Wait for every background lane to finish.
for pid in "${phase1_pids[@]}"; do
  wait "$pid" || true
done

# ─── Stream worker logs ─────────────────────────────────────────────────────
for ((w = 0; w < PARALLELISM; w++)); do
  log_file="$REPORT_DIR/logs/worker-${w}.log"
  if [ -f "$log_file" ]; then
    echo "━━━━━━ Worker $w ━━━━━━"
    cat "$log_file"
  fi
done

# ─── Aggregate results ──────────────────────────────────────────────────────
PASSED=0
FAILED=0
FAILURES=()
for ((w = 0; w < PARALLELISM; w++)); do
  results_file="$REPORT_DIR/logs/worker-${w}.results"
  [ -f "$results_file" ] || continue
  while IFS= read -r line; do
    case "$line" in
      "PASS "*) PASSED=$((PASSED + 1)) ;;
      "FAIL "*)
        FAILED=$((FAILED + 1))
        FAILURES+=("${line#FAIL }")
        ;;
    esac
  done < "$results_file"
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: $PASSED passed, $FAILED failed (parallelism=$PARALLELISM)"
if [ ${#FAILURES[@]} -gt 0 ]; then
  echo "  Failed flows:"
  for f in "${FAILURES[@]}"; do echo "    - $f"; done
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Build the markdown summary once and write it to $REPORT_DIR/summary.md so
# the CI workflow can post it as a sticky PR comment. Also append it to
# $GITHUB_STEP_SUMMARY so it renders on the Actions run page.
SUMMARY_FILE="$REPORT_DIR/summary.md"
{
  echo "## Maestro E2E results"
  echo ""
  echo "**$PASSED passed · $FAILED failed** (${#SMOKE_FLOWS[@]} total${TAG:+, tag \`$TAG\`}, parallelism $PARALLELISM)"
  echo ""
  echo "| Status | Flow |"
  echo "| :---: | --- |"
  for flow in "${SMOKE_FLOWS[@]}"; do
    if printf '%s\n' "${FAILURES[@]}" | grep -Fxq "$flow"; then
      echo "| ❌ | \`$flow\` |"
    else
      echo "| ✅ | \`$flow\` |"
    fi
  done
} > "$SUMMARY_FILE"

if [ -n "$GITHUB_STEP_SUMMARY" ]; then
  cat "$SUMMARY_FILE" >> "$GITHUB_STEP_SUMMARY"
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  exit 1
fi
