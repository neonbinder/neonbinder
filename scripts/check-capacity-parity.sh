#!/usr/bin/env bash
#
# NEO-299: assert the three numbers that describe preprocess capacity agree —
# apps/web/convex/preprocessCapacity.json (Convex parallelism, single source
# of truth), the workflow `env:` literals that cap each `gcloud run deploy`
# (preprocess.yml, preprocess-deploy.yml, browser.yml), and the Terraform
# `neonbinder_ioc` tfvars that size the live Cloud Run services.
#
# WHY THIS EXISTS
#
# Before NEO-299 these three numbers could (and did) disagree silently:
# nothing deployed the live Cloud Run service's --max-instances from a
# tracked value, nothing compared Terraform's tfvars against Convex's
# parallelism env vars, and nothing asserted a preview revision's cap at all.
#
# WHAT THIS CHECKS
#
#   1. WORKFLOW LITERALS vs JSON — strict. The `env:` literals this repo's own
#      workflows pass to `gcloud run deploy --max-instances` must exactly
#      equal the JSON's numbers for that environment. This is the one comparison
#      entirely within this repo's control, so a mismatch always fails.
#
#   2. TFVARS vs JSON — a separate repo (`neonbinder_ioc`), fetched over the
#      network from public raw URLs (no clone, no auth: both repos are
#      public). Two tolerances, both explained in NEO-299's decision comment
#      sequencing note:
#
#        a. ABSENT vs PRESENT. A tfvars file that doesn't set the variable
#           means Terraform is still using its built-in default (currently 20
#           for both `heavy_preprocess_max_instances` and
#           `preprocess_max_instances`) — that is precisely the pre-NEO-299
#           bug this ticket exists to fix, not a NEW drift introduced by this
#           PR. Absence is reported as a WARNING, never a failure, so this
#           monorepo-side PR is not wedged behind the companion Terraform PR
#           landing first. Once a tfvars file explicitly sets the variable
#           (right or wrong), the comparison goes strict: an explicit wrong
#           value IS real drift and fails the job.
#
#        b. develop vs main for PROD. Terraform is GitFlow (CLAUDE.md): a
#           feature branch lands on `develop` (which applies to BOTH dev and
#           prod tfvars in one merge) and is promoted to `main` (prod's actual
#           apply target) separately, later. Checking prod's number against
#           `develop` gives real, immediate feedback the moment the Terraform
#           PR merges, without waiting on the promotion. `main` is ALSO
#           checked, but only as an always-informational, never-failing
#           signal — its natural state is "still catching up" between a
#           develop merge and the next promotion, which is expected staleness,
#           not drift.
#
# EXIT CODES
#   0  no strict violation (workflow-literal mismatch or an EXPLICIT tfvars
#      mismatch). Warnings (absent vars, main-vs-JSON) do not affect this.
#   1  a strict violation was found.
#   2  usage/precondition error (missing tool, unreadable JSON, network
#      failure fetching a tfvars file — a fetch failure is NOT treated as
#      "absent", since that would silently downgrade a real drift to a warning).
#
# This is READ-ONLY: no writes to this repo, Convex, GCP or the ioc repo.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSON_PATH="$REPO_ROOT/apps/web/convex/preprocessCapacity.json"

IOC_RAW_BASE="https://raw.githubusercontent.com/neonbinder/neonbinder_ioc"
TFVARS_DEV_URL="$IOC_RAW_BASE/develop/environments/dev.tfvars"
TFVARS_PROD_DEVELOP_URL="$IOC_RAW_BASE/develop/environments/prod.tfvars"
TFVARS_PROD_MAIN_URL="$IOC_RAW_BASE/main/environments/prod.tfvars"

# Fixed, not JSON-driven: the browser service preview is not a preprocess
# concern and has no row in preprocessCapacity.json, but NEO-299's decision
# comment (Jason, 2026-09-24) fixes it at 3 alongside the preprocess previews,
# so it is worth the same strict check against the workflow literal.
EXPECTED_BROWSER_PREVIEW=3

usage() {
  cat <<'EOF'
Usage: check-capacity-parity.sh [--json PATH]
                                 [--tfvars-dev-url URL]
                                 [--tfvars-prod-develop-url URL]
                                 [--tfvars-prod-main-url URL]
                                 [--skip-tfvars]

  --json PATH                  Path to preprocessCapacity.json
                                (default: apps/web/convex/preprocessCapacity.json)
  --tfvars-dev-url URL         Override the dev.tfvars source (default: ioc develop)
  --tfvars-prod-develop-url URL  Override the prod.tfvars@develop source
  --tfvars-prod-main-url URL   Override the prod.tfvars@main source
  --skip-tfvars                 Skip the network fetches (workflow-literal check only) —
                                 for offline/local runs; CI must NOT pass this.
EOF
}

SKIP_TFVARS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_PATH="$2"; shift 2 ;;
    --tfvars-dev-url) TFVARS_DEV_URL="$2"; shift 2 ;;
    --tfvars-prod-develop-url) TFVARS_PROD_DEVELOP_URL="$2"; shift 2 ;;
    --tfvars-prod-main-url) TFVARS_PROD_MAIN_URL="$2"; shift 2 ;;
    --skip-tfvars) SKIP_TFVARS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 2; }
[[ -f "$JSON_PATH" ]] || { echo "ERROR: $JSON_PATH not found" >&2; exit 2; }

json_heavy_prod=$(jq -r '.heavy.prod' "$JSON_PATH")
json_heavy_dev=$(jq -r '.heavy.dev' "$JSON_PATH")
json_heavy_preview=$(jq -r '.heavy.preview' "$JSON_PATH")
json_fast_prod=$(jq -r '.fast.prod' "$JSON_PATH")
json_fast_dev=$(jq -r '.fast.dev' "$JSON_PATH")
json_fast_preview=$(jq -r '.fast.preview' "$JSON_PATH")

for v in json_heavy_prod json_heavy_dev json_heavy_preview json_fast_prod json_fast_dev json_fast_preview; do
  val="${!v}"
  if [[ -z "$val" || "$val" == "null" ]]; then
    echo "ERROR: $JSON_PATH is missing a required field (checked via \$$v)" >&2
    exit 2
  fi
done

echo "== preprocessCapacity.json =="
echo "heavy: prod=$json_heavy_prod dev=$json_heavy_dev preview=$json_heavy_preview"
echo "fast:  prod=$json_fast_prod dev=$json_fast_dev preview=$json_fast_preview"
echo

fail=0
warn=0

# ---------------------------------------------------------------------------
# 0. Sanity checks on the JSON itself — the rest of this script only proves
#    the numbers AGREE with each other; it says nothing about whether the
#    agreed-upon number is itself sane. All three checks are strict (in-repo,
#    no network, no reason ever to warn-and-continue).
# ---------------------------------------------------------------------------

# 0a. Typo guard: every value must be an integer in [1, 50]. Mirrors
# preprocessCapacity.ts's own MAX_ACCEPTED_PARALLELISM bound, so a JSON value
# outside it would already be silently rejected at runtime (falling back to
# the prod default) — catch that here instead of discovering it as a
# capacity mismatch in production.
for pair in "heavy.prod=$json_heavy_prod" "heavy.dev=$json_heavy_dev" "heavy.preview=$json_heavy_preview" \
            "fast.prod=$json_fast_prod" "fast.dev=$json_fast_dev" "fast.preview=$json_fast_preview"; do
  label="${pair%%=*}"
  val="${pair#*=}"
  if [[ "$val" =~ ^[0-9]+$ ]] && [ "$val" -ge 1 ] && [ "$val" -le 50 ]; then
    echo "ok    sanity: $label=$val is an integer in [1,50]"
  else
    echo "FAIL  sanity: $label=$val is not an integer in [1,50] (preprocessCapacity.ts accepts only this range; anything else falls back silently at runtime)"
    fail=1
  fi
done

# 0b. Ordering: preview <= dev <= prod, per pool. Preview and dev share Cloud
# Run capacity with every other PR in flight at once (NEO-299's whole reason
# for existing), so either one outrunning prod's width makes no sense — prod
# is the only environment that owns its capacity outright.
check_ordering() {
  local pool="$1" preview="$2" dev="$3" prod="$4"
  if [ "$preview" -le "$dev" ] && [ "$dev" -le "$prod" ]; then
    echo "ok    sanity: $pool preview($preview) <= dev($dev) <= prod($prod)"
  else
    echo "FAIL  sanity: $pool ordering violated — expected preview <= dev <= prod, got preview=$preview dev=$dev prod=$prod"
    fail=1
  fi
}
check_ordering "heavy" "$json_heavy_preview" "$json_heavy_dev" "$json_heavy_prod"
check_ordering "fast"  "$json_fast_preview"  "$json_fast_dev"  "$json_fast_prod"

# 0c/0d. Cloud Run memory quota arithmetic — 400 GiB per region, per project
# (prod and dev each have their own 400 GiB budget; this is NOT a shared pool
# between them). container_concurrency=1 on both preprocess services (NEO-161)
# means instance count IS concurrent request count, so "every instance fully
# warm at once" is the real worst case, not a padded estimate.
HEAVY_GIB=16
FAST_GIB=8
PROD_BROWSER_GIB_TOTAL=40   # prod browser: 20 instances x 2 GiB
DEV_BROWSER_GIB_TOTAL=80    # dev browser: 20 instances x 4 GiB
PREVIEW_BROWSER_GIB_TOTAL=6 # one PR's browser preview: 3 instances x 2 GiB (browser.yml)

prod_heavy_gib=$(( json_heavy_prod * HEAVY_GIB ))
prod_fast_gib=$(( json_fast_prod * FAST_GIB ))
prod_sum=$(( prod_heavy_gib + prod_fast_gib + PROD_BROWSER_GIB_TOTAL ))
if [ "$prod_sum" -le 400 ]; then
  echo "ok    sanity: prod fully-warm memory ${prod_sum} GiB <= 400 GiB quota (heavy ${json_heavy_prod}x${HEAVY_GIB}=${prod_heavy_gib} + fast ${json_fast_prod}x${FAST_GIB}=${prod_fast_gib} + browser ${PROD_BROWSER_GIB_TOTAL})"
else
  echo "FAIL  sanity: prod fully-warm memory ${prod_sum} GiB EXCEEDS the 400 GiB/region Cloud Run quota — heavy ${json_heavy_prod}x${HEAVY_GIB}GiB=${prod_heavy_gib} + fast ${json_fast_prod}x${FAST_GIB}GiB=${prod_fast_gib} + browser ${PROD_BROWSER_GIB_TOTAL}GiB = ${prod_sum}GiB. Lower heavy.prod and/or fast.prod, or this WILL 429/OOM once every instance is warm simultaneously."
  fail=1
fi

# One PR preview's addon is computed once and reused in the message below so
# the arithmetic reads the same way it was derived (NEO-299's decision
# comment: "one preview +N GiB").
preview_heavy_gib=$(( json_heavy_preview * HEAVY_GIB ))
preview_fast_gib=$(( json_fast_preview * FAST_GIB ))
preview_addon=$(( preview_heavy_gib + preview_fast_gib + PREVIEW_BROWSER_GIB_TOTAL ))

dev_heavy_gib=$(( json_heavy_dev * HEAVY_GIB ))
dev_fast_gib=$(( json_fast_dev * FAST_GIB ))
dev_sum=$(( dev_heavy_gib + dev_fast_gib + DEV_BROWSER_GIB_TOTAL + preview_addon ))
if [ "$dev_sum" -le 400 ]; then
  echo "ok    sanity: dev + one PR preview fully-warm memory ${dev_sum} GiB <= 400 GiB quota (dev: heavy ${json_heavy_dev}x${HEAVY_GIB}=${dev_heavy_gib} + fast ${json_fast_dev}x${FAST_GIB}=${dev_fast_gib} + browser ${DEV_BROWSER_GIB_TOTAL}; +one preview ${preview_addon} [heavy ${json_heavy_preview}x${HEAVY_GIB}=${preview_heavy_gib} + fast ${json_fast_preview}x${FAST_GIB}=${preview_fast_gib} + browser ${PREVIEW_BROWSER_GIB_TOTAL}])"
else
  echo "FAIL  sanity: dev + one PR preview fully-warm memory ${dev_sum} GiB EXCEEDS the 400 GiB/region Cloud Run quota — dev (heavy ${json_heavy_dev}x${HEAVY_GIB}GiB=${dev_heavy_gib} + fast ${json_fast_dev}x${FAST_GIB}GiB=${dev_fast_gib} + browser ${DEV_BROWSER_GIB_TOTAL}GiB) + one preview (heavy ${json_heavy_preview}x${HEAVY_GIB}GiB=${preview_heavy_gib} + fast ${json_fast_preview}x${FAST_GIB}GiB=${preview_fast_gib} + browser ${PREVIEW_BROWSER_GIB_TOTAL}GiB) = ${dev_sum}GiB. This is the exact quota-exhaustion shape a PR preview can trigger alongside the shared dev revision — lower heavy.dev/fast.dev and/or heavy.preview/fast.preview."
  fail=1
fi
echo

# ---------------------------------------------------------------------------
# 1. Workflow env: literals vs JSON — strict, in-repo, no network.
# ---------------------------------------------------------------------------

# Extracts the value of `NAME: <number>` from a workflow's top-level `env:`
# block. Deliberately simple (no YAML parser) — these are hand-written scalar
# literals we control, one per line, by convention (see the edits' comments
# in each workflow). A missing var is a hard error: it means the workflow no
# longer exposes the literal this script depends on, which is itself drift
# worth catching, not something to warn past.
extract_env_literal() {
  local file="$1" name="$2"
  local line
  line=$(grep -E "^[[:space:]]{2}${name}:[[:space:]]*[0-9]+[[:space:]]*$" "$file" || true)
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  echo "$line" | sed -E "s/^[[:space:]]*${name}:[[:space:]]*([0-9]+)[[:space:]]*$/\1/"
}

check_literal() {
  local label="$1" file="$2" name="$3" expected="$4"
  local rel="${file#"$REPO_ROOT"/}"
  local actual
  actual=$(extract_env_literal "$file" "$name")
  if [[ -z "$actual" ]]; then
    echo "FAIL  $label: $name not found in $rel"
    fail=1
    return
  fi
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL  $label: $rel:$name=$actual, expected $expected (preprocessCapacity.json)"
    fail=1
  else
    echo "ok    $label: $rel:$name=$actual"
  fi
}

echo "== workflow env: literals (strict) =="
check_literal "preprocess preview / heavy" "$REPO_ROOT/.github/workflows/preprocess.yml" "PREVIEW_HEAVY_MAX_INSTANCES" "$json_heavy_preview"
check_literal "preprocess preview / fast"  "$REPO_ROOT/.github/workflows/preprocess.yml" "PREVIEW_FAST_MAX_INSTANCES"  "$json_fast_preview"
check_literal "preprocess deploy / heavy dev"   "$REPO_ROOT/.github/workflows/preprocess-deploy.yml" "DEV_HEAVY_MAX_INSTANCES"   "$json_heavy_dev"
check_literal "preprocess deploy / heavy prod"  "$REPO_ROOT/.github/workflows/preprocess-deploy.yml" "PROD_HEAVY_MAX_INSTANCES"  "$json_heavy_prod"
check_literal "preprocess deploy / fast dev"    "$REPO_ROOT/.github/workflows/preprocess-deploy.yml" "DEV_FAST_MAX_INSTANCES"    "$json_fast_dev"
check_literal "preprocess deploy / fast prod"   "$REPO_ROOT/.github/workflows/preprocess-deploy.yml" "PROD_FAST_MAX_INSTANCES"   "$json_fast_prod"
check_literal "browser preview" "$REPO_ROOT/.github/workflows/browser.yml" "PREVIEW_BROWSER_MAX_INSTANCES" "$EXPECTED_BROWSER_PREVIEW"
echo

# ---------------------------------------------------------------------------
# 2. Terraform tfvars vs JSON — network fetch from the public ioc repo.
# ---------------------------------------------------------------------------

fetch_tfvars() {
  local url="$1"
  curl -fsSL --retry 3 --retry-all-errors --max-time 20 "$url" 2>/dev/null
}

# Reads `name = <number>` from tfvars content on stdin-like variable. Comments
# start with `#`; tfvars uses `=`, not `:`. Prints nothing if absent.
tfvars_value() {
  local content="$1" name="$2"
  echo "$content" | grep -E "^[[:space:]]*${name}[[:space:]]*=[[:space:]]*[0-9]+[[:space:]]*(#.*)?$" \
    | head -1 \
    | sed -E "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*(#.*)?$/\1/"
}

# expected: PASS if present & equal, FAIL (strict) if present & unequal,
# WARN if absent (Terraform default still in force — see header comment).
check_tfvars() {
  local label="$1" content="$2" name="$3" expected="$4" strict_absent="${5:-0}"
  local val
  val=$(tfvars_value "$content" "$name")
  if [[ -z "$val" ]]; then
    if [[ "$strict_absent" == "1" ]]; then
      echo "FAIL  $label: $name not set (Terraform default in force) — expected explicit $expected"
      fail=1
    else
      echo "WARN  $label: $name not set (Terraform default in force, expected $expected once set)"
      warn=1
    fi
    return
  fi
  if [[ "$val" != "$expected" ]]; then
    echo "FAIL  $label: $name=$val, expected $expected (preprocessCapacity.json)"
    fail=1
  else
    echo "ok    $label: $name=$val"
  fi
}

if [[ "$SKIP_TFVARS" == "1" ]]; then
  echo "== terraform tfvars (SKIPPED via --skip-tfvars — do not use in CI) =="
else
  echo "== terraform tfvars: dev (ioc develop, strict once set) =="
  dev_tfvars=$(fetch_tfvars "$TFVARS_DEV_URL") || { echo "ERROR: could not fetch $TFVARS_DEV_URL" >&2; exit 2; }
  check_tfvars "dev heavy" "$dev_tfvars" "heavy_preprocess_max_instances" "$json_heavy_dev"
  check_tfvars "dev fast"  "$dev_tfvars" "preprocess_max_instances"       "$json_fast_dev"
  echo

  echo "== terraform tfvars: prod @ develop (ioc develop, strict once set — this is the real-time prod signal; main lags until promotion) =="
  prod_develop_tfvars=$(fetch_tfvars "$TFVARS_PROD_DEVELOP_URL") || { echo "ERROR: could not fetch $TFVARS_PROD_DEVELOP_URL" >&2; exit 2; }
  check_tfvars "prod@develop heavy" "$prod_develop_tfvars" "heavy_preprocess_max_instances" "$json_heavy_prod"
  check_tfvars "prod@develop fast"  "$prod_develop_tfvars" "preprocess_max_instances"       "$json_fast_prod"
  echo

  echo "== terraform tfvars: prod @ main (ioc main — informational ONLY, never fails; expected to lag until the next develop->main promotion) =="
  prod_main_tfvars=$(fetch_tfvars "$TFVARS_PROD_MAIN_URL") || { echo "ERROR: could not fetch $TFVARS_PROD_MAIN_URL" >&2; exit 2; }
  main_heavy=$(tfvars_value "$prod_main_tfvars" "heavy_preprocess_max_instances")
  main_fast=$(tfvars_value "$prod_main_tfvars" "preprocess_max_instances")
  if [[ -z "$main_heavy" ]]; then
    echo "INFO  prod@main heavy: not set (Terraform default in force; expects $json_heavy_prod after promotion)"
  elif [[ "$main_heavy" != "$json_heavy_prod" ]]; then
    echo "INFO  prod@main heavy: $main_heavy, expects $json_heavy_prod (not yet promoted from develop — not a failure)"
  else
    echo "ok    prod@main heavy: $main_heavy"
  fi
  if [[ -z "$main_fast" ]]; then
    echo "INFO  prod@main fast: not set (Terraform default in force; expects $json_fast_prod after promotion)"
  elif [[ "$main_fast" != "$json_fast_prod" ]]; then
    echo "INFO  prod@main fast: $main_fast, expects $json_fast_prod (not yet promoted from develop — not a failure)"
  else
    echo "ok    prod@main fast: $main_fast"
  fi
  echo
fi

if [[ "$fail" != "0" ]]; then
  echo "capacity-parity: FAIL — see FAIL lines above."
  exit 1
fi

if [[ "$warn" != "0" ]]; then
  echo "capacity-parity: PASS with warnings (Terraform not yet caught up to preprocessCapacity.json — see WARN lines above)."
else
  echo "capacity-parity: PASS."
fi
exit 0
