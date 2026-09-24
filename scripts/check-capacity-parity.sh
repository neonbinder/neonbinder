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
# Before NEO-299 these could (and did) disagree silently: Terraform's
# heavy_preprocess_max_instances defaulted to 20 and was never set in either
# environment's tfvars, a hand-run `gcloud run deploy` on 2026-04-16 pinned the
# LIVE service at 5 with that value in no repo, and Convex's
# HEAVY_PREPROCESS_MAX_PARALLELISM read 3 in prod. Nothing compared them.
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
  curl -fsSL --max-time 15 "$url" 2>/dev/null
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
