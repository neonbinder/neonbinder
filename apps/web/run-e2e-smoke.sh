#!/bin/bash
# Runs E2E flows across N parallel workers using a tag-driven scheduler.
#
# Each Maestro flow declares its scheduling profile via tags in its `tags:`
# block. Three families exist:
#
#   - `isolated:true` (or legacy `serial-global`) — flow mutates global Convex
#     tables (selectorOptions / cardChecklist / players / teams) by clicking
#     "Reset Set Builder Data" or otherwise touching cross-user data. These
#     flows must serialize alone and cannot run concurrently with the cascade
#     (see below).
#
#   - `serial-marketplace` — flow hits /login/bsc or /login/sportlots on the
#     browser service. The browser service returns 503 on concurrent
#     marketplace logins, so these serialize on a dedicated worker. They CAN
#     run concurrently with isolated and with the cascade — they only conflict
#     with each other.
#
#   - `requires:<state>` and `provides:<state>` — the dependency graph. A flow
#     tagged `requires:X` only runs after every flow tagged `provides:X` has
#     completed. States are author-defined strings (e.g. `setup-done`,
#     `sets-loaded`, `cards-loaded`). Future feature flows plug into this
#     graph by declaring their own requires/provides — no runner changes.
#
# Untagged flows are parallel-safe and distributed round-robin across workers.
#
# Execution model:
#   Phase 1 (concurrent across all workers):
#     - Lane I: isolated flows        (serial on dedicated worker)
#     - Lane M: marketplace flows     (serial on dedicated worker)
#     - Lane P: independent flows     (parallel, distributed)
#     Wait for Lane I (and Lane M) to finish before Phase 2 starts. Lane P
#     keeps running concurrently with Phase 2 if it's still going.
#
#   Phase 2 (cascade levels in order):
#     For each level 0..N: distribute that level's depgraph flows across all
#     currently-free workers and wait for the level to finish before the next.
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
#   MAESTRO_DISABLE_DEP_GRAPH=1 ./run-e2e-smoke.sh   # rollback to static-lane behavior

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
APP_URL="${APP_URL:-https://localhost:3000}"
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
#   - The serial backbone (isolated + marketplace + dep-graph cascade) runs ONLY
#     on shard 0; other shards run a deterministic slice of the parallel-safe
#     "independent" flows (see the shard partition after categorization).
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

# Rollback flag: if anything misbehaves with the dep-graph scheduler, set
# MAESTRO_DISABLE_DEP_GRAPH=1 to fall back to static-lane behavior. The
# dep-graph and isolated lanes both collapse into a single "serial" bucket.
DISABLE_DEP_GRAPH="${MAESTRO_DISABLE_DEP_GRAPH:-}"

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
# Prerequisite closure (default ON): any selected flow tagged `requires:X`
# automatically pulls in the flows tagged `provides:X`, transitively — e.g. a
# single `requires:cards-loaded` flow drags in the cards → sets → setup
# cascade so it actually runs with its data seeded. Controls:
#   MAESTRO_NO_DEPS=1        don't pull prerequisites; treat each selected
#                            flow's `requires:` as already-satisfied so it runs
#                            immediately (use only when data is pre-seeded).
#   MAESTRO_MINIMAL_DEPS=1   pull only ONE producer per required state (prefer
#                            a `cascade`-tagged one) instead of every producer.
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
flow_provides_states(){ flow_tags "$1" | sed -n 's/^provides://p'; }
flow_requires_states(){ flow_tags "$1" | sed -n 's/^requires://p'; }

NO_DEPS="${MAESTRO_NO_DEPS:-}"
MINIMAL_DEPS="${MAESTRO_MINIMAL_DEPS:-}"

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

# ─── Prerequisite closure ───────────────────────────────────────────────────
# For each selected flow's `requires:X`, add the universe flows tagged
# `provides:X`, transitively. Dedup via a sentinel-padded membership string
# (bash 3.2 on macOS has no associative arrays). No-op when every producer is
# already selected — so the `""` / `smoke` / `regression` CI invocations are
# byte-for-byte unchanged.
SELECTED_PATHS=""
for f in "${SELECTED_FLOWS[@]}"; do SELECTED_PATHS="$SELECTED_PATHS $f"; done
in_selected() { case "$SELECTED_PATHS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

if [ -z "$NO_DEPS" ]; then
  PRODUCER_UNIVERSE=()
  while IFS= read -r f; do
    flow_has_tag "$f" util && continue
    flow_has_tag "$f" wip && continue
    PRODUCER_UNIVERSE+=("$f")
  done < <(find .maestro/flows/ -name "*.yaml" | sort)

  worklist=("${SELECTED_FLOWS[@]}")
  while [ ${#worklist[@]} -gt 0 ]; do
    cur="${worklist[0]}"
    worklist=("${worklist[@]:1}")
    while IFS= read -r state; do
      [ -z "$state" ] && continue
      producers=()
      for p in "${PRODUCER_UNIVERSE[@]}"; do
        if flow_provides_states "$p" | grep -qxF "$state"; then producers+=("$p"); fi
      done
      if [ ${#producers[@]} -eq 0 ]; then
        echo "WARNING: a selected flow requires state \"$state\" but no flow provides it." >&2
        continue
      fi
      if [ -n "$MINIMAL_DEPS" ]; then
        chosen=""
        for p in "${producers[@]}"; do
          if flow_has_tag "$p" cascade; then chosen="$p"; break; fi
        done
        [ -z "$chosen" ] && chosen="${producers[0]}"
        producers=("$chosen")
      fi
      for p in "${producers[@]}"; do
        if ! in_selected "$p"; then
          SELECTED_FLOWS+=("$p")
          SELECTED_PATHS="$SELECTED_PATHS $p"
          worklist+=("$p")
        fi
      done
    done < <(flow_requires_states "$cur")
  done
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

# Parallel indexed arrays keyed by SMOKE_FLOWS position. Bash 3.2 compatible
# (macOS ships 3.2; no associative arrays). Look up via flow_idx_of() if you
# only have the path.
FLOW_REQUIRES_LIST=()   # space-separated state names per flow
FLOW_PROVIDES_LIST=()
FLOW_CATEGORY_LIST=()   # isolated | marketplace | depgraph | independent
FLOW_LEVEL_LIST=()      # depgraph: integer level; others: empty

flow_idx_of() {
  local target=$1
  local i
  for i in "${!SMOKE_FLOWS[@]}"; do
    if [ "${SMOKE_FLOWS[$i]}" = "$target" ]; then
      echo "$i"
      return 0
    fi
  done
  echo "-1"
  return 1
}

for i in "${!SMOKE_FLOWS[@]}"; do
  flow="${SMOKE_FLOWS[$i]}"
  req=""
  prov=""
  is_isolated=false
  is_marketplace=false
  has_dep=false
  while IFS= read -r tag; do
    case "$tag" in
      # MAESTRO_NO_DEPS asserts prerequisites are already seeded: drop the
      # `requires:` edges so the flow schedules immediately (as independent /
      # provides-only) instead of being skipped for an unsatisfiable state.
      requires:*)         [ -z "$NO_DEPS" ] && { req="$req ${tag#requires:}"; has_dep=true; } ;;
      provides:*)         prov="$prov ${tag#provides:}"; has_dep=true ;;
      isolated|isolated:true) is_isolated=true ;;
      serial-global)      is_isolated=true ;;   # legacy alias for backwards compat
      serial-marketplace) is_marketplace=true ;;
    esac
  done < <(flow_tags "$flow")
  FLOW_REQUIRES_LIST[$i]="${req# }"
  FLOW_PROVIDES_LIST[$i]="${prov# }"
  FLOW_LEVEL_LIST[$i]=""

  # Categorization. With DISABLE_DEP_GRAPH, depgraph flows fold into isolated
  # so the runner falls back to today's static-lane behavior (everything that
  # would be cascade just runs serially in the isolated lane).
  if [ -n "$DISABLE_DEP_GRAPH" ] && $has_dep; then
    is_isolated=true
    has_dep=false
  fi
  if $is_isolated; then
    FLOW_CATEGORY_LIST[$i]="isolated"
  elif $is_marketplace; then
    FLOW_CATEGORY_LIST[$i]="marketplace"
  elif $has_dep; then
    FLOW_CATEGORY_LIST[$i]="depgraph"
  else
    FLOW_CATEGORY_LIST[$i]="independent"
  fi
done

# Bucket flows by category. We keep these as flow paths (not indices) for
# easy iteration in the lane runners.
ISOLATED_FLOWS=()
MARKETPLACE_FLOWS=()
DEPGRAPH_FLOWS=()
INDEPENDENT_FLOWS=()
for i in "${!SMOKE_FLOWS[@]}"; do
  case "${FLOW_CATEGORY_LIST[$i]}" in
    isolated)    ISOLATED_FLOWS+=("${SMOKE_FLOWS[$i]}") ;;
    marketplace) MARKETPLACE_FLOWS+=("${SMOKE_FLOWS[$i]}") ;;
    depgraph)    DEPGRAPH_FLOWS+=("${SMOKE_FLOWS[$i]}") ;;
    independent) INDEPENDENT_FLOWS+=("${SMOKE_FLOWS[$i]}") ;;
  esac
done

# ─── Shard partition (NEO-46) ───────────────────────────────────────────────
# Trim the categorized buckets to this shard's slice. No-op when SHARD_TOTAL=1.
#
#   - Serial backbone (isolated / marketplace / dep-graph) is shard-0-only:
#     non-zero shards empty those buckets so MAX_LEVEL stays -1 and they run no
#     cascade or serial-lane work.
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
    DEPGRAPH_FLOWS=()
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

# ─── Level computation for the dep-graph cascade ────────────────────────────
# Iterative topological sort. For each pending flow, level = 1 + max(level of
# every producer of every required state). Flows with no requires are level 0.
# Cycle / unproducible-state detection: if a round produces no progress, abort.
MAX_LEVEL=-1
if [ ${#DEPGRAPH_FLOWS[@]} -gt 0 ]; then
  pending=("${DEPGRAPH_FLOWS[@]}")
  current_level=0
  while [ ${#pending[@]} -gt 0 ]; do
    promoted=()
    next_pending=()
    for flow in "${pending[@]}"; do
      flow_i=$(flow_idx_of "$flow")
      satisfied=true
      for state in ${FLOW_REQUIRES_LIST[$flow_i]}; do
        # Has every producer of this state been assigned a level already?
        for producer in "${DEPGRAPH_FLOWS[@]}"; do
          producer_i=$(flow_idx_of "$producer")
          if [[ " ${FLOW_PROVIDES_LIST[$producer_i]} " == *" $state "* ]]; then
            if [ -z "${FLOW_LEVEL_LIST[$producer_i]}" ]; then
              satisfied=false
              break 2
            fi
          fi
        done
      done
      if $satisfied; then
        promoted+=("$flow")
      else
        next_pending+=("$flow")
      fi
    done
    if [ ${#promoted[@]} -eq 0 ]; then
      echo "ERROR: dep-graph has a cycle or required state has no producer." >&2
      for flow in "${pending[@]}"; do
        flow_i=$(flow_idx_of "$flow")
        echo "  unscheduled: $flow (requires: ${FLOW_REQUIRES_LIST[$flow_i]})" >&2
      done
      exit 2
    fi
    for flow in "${promoted[@]}"; do
      flow_i=$(flow_idx_of "$flow")
      FLOW_LEVEL_LIST[$flow_i]=$current_level
    done
    [ "$current_level" -gt "$MAX_LEVEL" ] && MAX_LEVEL=$current_level
    pending=("${next_pending[@]}")
    current_level=$((current_level + 1))
  done
fi

# ─── Plan summary ───────────────────────────────────────────────────────────
case "$SELECT_MODE" in
  all)   sel_label="all flows" ;;
  setup) sel_label="setup track (pre-matrix seed)" ;;
  tag)   sel_label="tag \"$TAG\"" ;;
  name)  sel_label="name ~ ${PATTERNS[*]}" ;;
  grep)  sel_label="grep /${PATTERNS[0]}/" ;;
esac
if [ -n "$NO_DEPS" ]; then dep_label=" — NO prerequisites (requires: treated as pre-seeded)"
elif [ -n "$MINIMAL_DEPS" ]; then dep_label=" — minimal prerequisites (1 producer/state)"
else dep_label=" — full prerequisite closure"; fi
echo "Selector: ${SELECTOR:-(none)}  →  ${sel_label}${dep_label}"
echo "Found ${#SMOKE_FLOWS[@]} flow(s)${TAG:+ tagged \"$TAG\"}"
echo "  Isolated:    ${#ISOLATED_FLOWS[@]}"
echo "  Marketplace: ${#MARKETPLACE_FLOWS[@]}"
echo "  Independent: ${#INDEPENDENT_FLOWS[@]}"
echo "  Dep-graph:   ${#DEPGRAPH_FLOWS[@]} (levels 0..$MAX_LEVEL)"
echo "Parallelism: $PARALLELISM worker(s)${DISABLE_DEP_GRAPH:+ — DEP_GRAPH DISABLED}"
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
if [ ${#DEPGRAPH_FLOWS[@]} -gt 0 ]; then
  for ((lvl = 0; lvl <= MAX_LEVEL; lvl++)); do
    echo "  Cascade level $lvl:"
    for flow in "${DEPGRAPH_FLOWS[@]}"; do
      flow_i=$(flow_idx_of "$flow")
      if [ "${FLOW_LEVEL_LIST[$flow_i]}" = "$lvl" ]; then
        provs="${FLOW_PROVIDES_LIST[$flow_i]:-(no provides)}"
        reqs="${FLOW_REQUIRES_LIST[$flow_i]:-(no requires)}"
        echo "    $flow  [requires: $reqs] [provides: $provs]"
      fi
    done
  done
fi
echo ""

# Plan-only: print the schedule and exit without launching Maestro. Lets you
# verify a selector (and its prerequisite closure) before committing to a run.
if [ -n "${MAESTRO_PLAN_ONLY:-}" ]; then
  echo "MAESTRO_PLAN_ONLY set — exiting before execution."
  exit 0
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
  # Run with 1 retry on non-timeout failures. The Maestro CDP web driver
  # has documented intermittent failures ("null cannot be cast to non-null
  # type kotlin.Int", "Failed to execute JS") that happen between successful
  # scrollUntilVisible and the immediately-following tap on the same element.
  # The JVM has also been observed to SIGSEGV/SIGBUS mid-flow. These
  # infrastructure flakes do not reflect product bugs and almost always
  # succeed on a second attempt. Retry is bounded to 1 (worst case: 2x
  # runtime per flow) and is skipped for timeout codes since those usually
  # mean a slow/hung product path that retry won't help.
  local exit_code=0
  local attempt=1
  local max_attempts="${MAESTRO_FLOW_RETRIES:-2}"
  while [ "$attempt" -le "$max_attempts" ]; do
    exit_code=0
    if [ "$attempt" -gt 1 ]; then
      echo "↻ [w$worker_index] Retry attempt $attempt/$max_attempts: $flow" >> "$log_file"
    fi
    # Per-attempt unique ID. Flows that add cards to the global
    # cardChecklist table reference ${ATTEMPT_ID} in their card
    # numbers + player names so attempt 2 doesn't collide with the
    # rows attempt 1 left behind (setup.yaml's resetSetBuilderData
    # only runs once per CI run, not between in-run retries).
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
    echo "❌ [w$worker_index] Failed after $max_attempts attempts: $flow" >> "$log_file"
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

# run_parallel_batch <flow...>
# Runs the given flows in parallel, one per worker, capped at PARALLELISM.
# Worker indices are reused: with PARALLELISM=3 and 5 flows, flows 1..3 run on
# workers 0..2, then flows 4..5 run on workers 0..1. Per-worker log/results
# files are appended to (preserving prior runs in the same lane file).
# Worker 0 is reserved for the SERIAL_WORKER_INDEX during phase 1 — pass a
# starting index to avoid collisions if needed.
run_parallel_batch() {
  local flows=("$@")
  if [ ${#flows[@]} -eq 0 ]; then return 0; fi
  local pids=()
  local worker_index_offset="${WORKER_INDEX_OFFSET:-0}"
  for i in "${!flows[@]}"; do
    local w=$(( (i + worker_index_offset) % PARALLELISM ))
    run_flow_on_worker "$w" "${flows[$i]}" &
    pids+=($!)
    # Cap concurrent maestro processes at PARALLELISM
    if [ "${#pids[@]}" -ge "$PARALLELISM" ]; then
      wait "${pids[0]}" || true
      pids=("${pids[@]:1}")
    fi
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || true
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
# The cascade in phase 2 is gated on the isolated lane finishing — marketplace
# and independent lanes can keep running concurrently with the cascade.
#
# Special case PARALLELISM=1: everything serial on worker 0 in order
# isolated → marketplace → independent → cascade.
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

# Wait for the isolated lane specifically (the cascade can't start until it's done).
if [ -n "$ISOLATED_PID" ]; then
  wait "$ISOLATED_PID" || true
fi

# ─── Phase 2: cascade levels ────────────────────────────────────────────────
# For each level 0..N: run that level's depgraph flows in parallel across all
# workers and wait before moving to the next level.
#
# All PARALLELISM workers are eligible. The marketplace and independent lanes
# might still be running (they own workers 1 and 2..N-1 respectively); using
# the same indices is fine because run_flow_on_worker just appends to that
# worker's log file. Maestro instances per worker remain serialized at the
# lane level (each lane has at most one maestro process at a time), but across
# lanes the OS can run multiple concurrently up to its scheduling limits.
#
# To keep concurrency bounded by PARALLELISM, we wait for any in-flight
# phase-1 background lane PIDs whose worker indices the cascade wants to use.
# Simpler approach: just cap cascade concurrency at PARALLELISM via the batch
# helper. The phase-1 lanes naturally finish during the cascade because each
# cascade level forks its own set of maestro processes.
# ─── Cascade prerequisite tracking ──────────────────────────────────────────
# Before NEO-23: if a level-N producer flow failed, level-N+1 flows ran anyway
# with state that didn't match what the test expected. That made local↔CI
# divergence noisy: a flake at level N changed downstream behavior in subtle
# ways (e.g. cards-insert "passing" locally only because sets-inserts SIGSEGV'd
# and didn't write reconciliation rows that would have tripped a validator bug
# in CI). Now: track which provides-states have at least one PASSing producer.
# Any flow whose requires can't be satisfied gets SKIPped and recorded as
# FAIL (the test wasn't run, but the cascade is broken — surface it).
#
# Opt out via MAESTRO_CASCADE_PERMISSIVE=true if you want the old run-anyway
# behavior (e.g. for debugging a single failing flow at level 0).
CASCADE_PERMISSIVE="${MAESTRO_CASCADE_PERMISSIVE:-}"

# Set of satisfied states, stored as a space-delimited string with sentinel
# spaces on both ends so simple `case` glob membership tests don't need
# tricky escaping. (Why not `declare -A`: macOS ships bash 3.2.57 which
# doesn't support associative arrays, and we want this script to run on
# dev macOS as well as Linux CI. Tracked as a follow-up to drop the bash
# wrapper entirely in favor of native Maestro orchestration.)
STATE_SATISFIED=" "

# state_is_satisfied <state> → exit 0 if at least one producer of <state>
# has passed, exit 1 otherwise. Membership test on STATE_SATISFIED.
state_is_satisfied() {
  case "$STATE_SATISFIED" in
    *" $1 "*) return 0 ;;
    *)        return 1 ;;
  esac
}

# Check whether a flow appears as PASS in any worker's results.
flow_passed_in_results() {
  local flow="$1"
  for ((w = 0; w < PARALLELISM; w++)); do
    if grep -qE "^PASS ${flow}\$" "$REPORT_DIR/logs/worker-${w}.results" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

if [ "$MAX_LEVEL" -ge 0 ]; then
  for ((lvl = 0; lvl <= MAX_LEVEL; lvl++)); do
    level_flows=()
    skipped_flows=()
    for flow in "${DEPGRAPH_FLOWS[@]}"; do
      flow_i=$(flow_idx_of "$flow")
      if [ "${FLOW_LEVEL_LIST[$flow_i]}" = "$lvl" ]; then
        # Check every required state has at least one passed producer.
        # (Level 0 flows have no requires, so this loop is a no-op for them.)
        missing_state=""
        if [ -z "$CASCADE_PERMISSIVE" ]; then
          for state in ${FLOW_REQUIRES_LIST[$flow_i]}; do
            if ! state_is_satisfied "$state"; then
              missing_state="$state"
              break
            fi
          done
        fi
        if [ -n "$missing_state" ]; then
          skipped_flows+=("$flow:$missing_state")
        else
          level_flows+=("$flow")
        fi
      fi
    done

    # Record skips before running this level so the worker-0 log shows them
    # in the right order. Each skip counts as a FAIL in the aggregate so the
    # cascade-broken state is visible in the sticky PR comment.
    for entry in "${skipped_flows[@]}"; do
      flow="${entry%%:*}"
      state="${entry##*:}"
      log_file="$REPORT_DIR/logs/worker-0.log"
      results_file="$REPORT_DIR/logs/worker-0.results"
      echo "⏭️  [w0] Skipped (missing prerequisite \"$state\"): $flow" >> "$log_file"
      echo "FAIL $flow (skipped: prerequisite \"$state\" not satisfied)" >> "$results_file"
    done

    if [ ${#level_flows[@]} -gt 0 ]; then
      run_parallel_batch "${level_flows[@]}"
    fi

    # After the level finishes, record any newly-satisfied states. A state is
    # satisfied iff at least one of its producers PASSed at this level (or
    # earlier; STATE_SATISFIED is monotonic-add).
    for flow in "${level_flows[@]}"; do
      if flow_passed_in_results "$flow"; then
        flow_i=$(flow_idx_of "$flow")
        for state in ${FLOW_PROVIDES_LIST[$flow_i]}; do
          # Skip duplicate-add: monotonic-add semantics, idempotent on repeat.
          if ! state_is_satisfied "$state"; then
            STATE_SATISFIED="${STATE_SATISFIED}${state} "
          fi
        done
      fi
    done
  done
fi

# Final wait: any phase-1 background lanes that didn't finish yet.
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
