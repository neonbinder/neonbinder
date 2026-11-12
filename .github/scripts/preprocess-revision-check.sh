#!/usr/bin/env bash
#
# Post-deploy checks for a preprocess Cloud Run revision (NEO-484, gate G5).
#
# `deploy-cloudrun` MERGES env vars (it passes --update-env-vars): a deploy
# keeps every variable the service template already carries, including one a
# different lane left behind. So no env var can be trusted to mark a lane, and
# every deploy lane asserts what actually landed on its revision instead.
#
#   env     the revision's env and execution environment
#   health  /health's `dev_cache` mode on a URL (read-only GET)
#
# Usage:
#   preprocess-revision-check.sh env --project P --service S (--tag T | --revision R)
#       [--absent NAME]... [--equals NAME=VALUE]... [--exec-env gen2]
#   preprocess-revision-check.sh health --url URL --expect-prefix PREFIX
#       [--warn-only] [--max-time SECONDS]
#
# `health` reads the ID token from $PROBE_TOKEN (never argv, so it cannot land
# in a process listing or a log line). Values are never printed for env vars
# outside --equals, so a secret-backed variable cannot leak through here.
#
# Exit: 0 pass (or a --warn-only miss), 1 assertion failed, 2 usage error.

set -euo pipefail

die_usage() { echo "usage error: $*" >&2; exit 2; }

mode="${1:-}"; shift || true

case "$mode" in
  env)
    project="" service="" tag="" revision="" exec_env=""
    absent=() equals=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --project)  project="${2:-}"; shift 2 ;;
        --service)  service="${2:-}"; shift 2 ;;
        --tag)      tag="${2:-}"; shift 2 ;;
        --revision) revision="${2:-}"; shift 2 ;;
        --absent)   absent+=("${2:-}"); shift 2 ;;
        --equals)   equals+=("${2:-}"); shift 2 ;;
        --exec-env) exec_env="${2:-}"; shift 2 ;;
        *) die_usage "unknown arg $1" ;;
      esac
    done
    [[ -n "$project" && -n "$service" ]] || die_usage "--project and --service are required"
    [[ -n "$tag" || -n "$revision" ]] || die_usage "--tag or --revision is required"

    work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
    if [[ -z "$revision" ]]; then
      gcloud run services describe "$service" --project="$project" --region=us-central1 \
        --format=json > "$work/svc.json"
      revision="$(jq -r --arg t "$tag" '.status.traffic[]? | select(.tag==$t) | .revisionName' "$work/svc.json" | head -n1)"
      [[ -n "$revision" && "$revision" != "null" ]] || { echo "::error::no revision carries tag $tag on $service"; exit 1; }
    fi
    gcloud run revisions describe "$revision" --project="$project" --region=us-central1 \
      --format=json > "$work/rev.json"

    failed=0
    names="$(jq -r '.spec.containers[0].env[]?.name' "$work/rev.json")"
    echo "revision $revision env names: $(tr '\n' ' ' <<< "$names")"

    # `${arr[@]+...}`: bash 3.2 (macOS) treats an empty array as unset under -u.
    for name in ${absent[@]+"${absent[@]}"}; do
      if grep -qxF "$name" <<< "$names"; then
        echo "::error::$service revision $revision carries $name; this lane must remove it."
        failed=1
      else
        echo "ok: $name absent"
      fi
    done
    for pair in ${equals[@]+"${equals[@]}"}; do
      name="${pair%%=*}"; want="${pair#*=}"
      got="$(jq -r --arg n "$name" '.spec.containers[0].env[]? | select(.name==$n) | .value // ""' "$work/rev.json")"
      if [[ "$got" == "$want" ]]; then
        echo "ok: $name has the expected value"
      else
        echo "::error::$service revision $revision: $name is '${got:-<unset>}', expected '$want'."
        failed=1
      fi
    done
    if [[ -n "$exec_env" ]]; then
      got="$(jq -r '.metadata.annotations["run.googleapis.com/execution-environment"] // .spec.executionEnvironment // ""' "$work/rev.json")"
      if [[ "$got" == "$exec_env" ]]; then
        echo "ok: execution environment $got"
      else
        echo "::error::$service revision $revision runs on '${got:-<default, gen1>}', expected $exec_env."
        failed=1
      fi
    fi
    exit "$failed"
    ;;

  health)
    url="" prefix="" warn_only=false max_time=300
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --url)           url="${2:-}"; shift 2 ;;
        --expect-prefix) prefix="${2:-}"; shift 2 ;;
        --warn-only)     warn_only=true; shift ;;
        --max-time)      max_time="${2:-}"; shift 2 ;;
        *) die_usage "unknown arg $1" ;;
      esac
    done
    [[ -n "$url" && -n "$prefix" ]] || die_usage "--url and --expect-prefix are required"
    [[ -n "${PROBE_TOKEN:-}" ]] || die_usage "PROBE_TOKEN is empty"

    report() {
      if [[ "$warn_only" == true ]]; then
        echo "::warning::$1"; exit 0
      fi
      echo "::error::$1"; exit 1
    }

    body="$(mktemp)"; trap 'rm -f "$body"' EXIT
    # The token goes in a header file on stdin, not argv.
    status="$(printf 'Authorization: Bearer %s\n' "$PROBE_TOKEN" \
      | curl -s -o "$body" -w '%{http_code}' --max-time "$max_time" -H @- "$url/health" || true)"
    [[ "$status" == "200" ]] || report "GET $url/health returned HTTP ${status:-none}."
    # dev_cache is the policy mode string (on, off:<reason>); accept an object
    # carrying it as .mode too, so a richer /health does not break this check.
    mode_val="$(jq -r '(.dev_cache | if type == "object" then .mode else . end) // ""' "$body" 2>/dev/null || true)"
    echo "$url/health dev_cache=${mode_val:-<absent>}"
    [[ "$mode_val" == "$prefix"* ]] || report "$url/health dev_cache is '${mode_val:-<absent>}', expected it to start with '$prefix'."
    echo "ok: dev_cache starts with $prefix"
    ;;

  *) die_usage "first argument must be env or health" ;;
esac
