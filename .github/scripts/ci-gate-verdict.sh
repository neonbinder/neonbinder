#!/usr/bin/env bash
# NEO-546: the `CI Gate` verdict, pulled out of pr-pipeline.yml so it can be
# tested. Reads the needs results from the environment, prints one line per
# problem and a final PASS/FAIL line, and exits 1 on FAIL.
#
# CHEAP MODE (a pull_request run while the merge queue is live) is the only
# place a skipped heavy job is acceptable. It needs BOTH:
#   EVENT_NAME == pull_request   and   FULL == "false"
# Any other value of either (merge_group, an empty or unreadable FULL, ...)
# is FULL mode, which is exactly the verdict this gate always had: preview,
# wiring and E2E must succeed, with the single dependency-manifest-only
# carve-out (NEO-87). A merge_group run that claims FULL=false is a fault.
#
# The heavy jobs a cheap run skips on purpose: web-preview, wire-browser-url,
# wire-preprocess-url, wire-preprocess-capacity, e2e, preprocess-crop-matrix,
# preprocess-mask-parity. Everything else (lint, typecheck, unit, area tests,
# hygiene, capacity parity) must still pass in cheap mode, and a heavy job
# that RAN must still succeed.
#
# Environment: EVENT_NAME, FULL, R_CHANGES, R_WEB_LINT, R_WEB_TYPECHECK,
# R_WEB_UNIT, R_BROWSER_TEST, R_PREPROCESS_TEST, R_SCRIPTS_TEST,
# R_SCANNER_TEST, R_SCANNER_BUILD, R_CROP_MATRIX, R_MASK_PARITY,
# R_PREPROCESS_CHANGED, R_WIRE, R_WIRE_PREPROCESS, R_WIRE_CAPACITY,
# R_WEB_PREVIEW, R_E2E, R_DEPS_ONLY, R_HYGIENE, R_CAPACITY_PARITY.
set -uo pipefail

EVENT_NAME="${EVENT_NAME:-}"
FULL="${FULL:-}"
R_CHANGES="${R_CHANGES:-}"
R_WEB_LINT="${R_WEB_LINT:-}"
R_WEB_TYPECHECK="${R_WEB_TYPECHECK:-}"
R_WEB_UNIT="${R_WEB_UNIT:-}"
R_BROWSER_TEST="${R_BROWSER_TEST:-}"
R_PREPROCESS_TEST="${R_PREPROCESS_TEST:-}"
R_SCRIPTS_TEST="${R_SCRIPTS_TEST:-}"
R_SCANNER_TEST="${R_SCANNER_TEST:-}"
R_SCANNER_BUILD="${R_SCANNER_BUILD:-}"
R_CROP_MATRIX="${R_CROP_MATRIX:-}"
R_MASK_PARITY="${R_MASK_PARITY:-}"
R_PREPROCESS_CHANGED="${R_PREPROCESS_CHANGED:-}"
R_WIRE="${R_WIRE:-}"
R_WIRE_PREPROCESS="${R_WIRE_PREPROCESS:-}"
R_WIRE_CAPACITY="${R_WIRE_CAPACITY:-}"
R_WEB_PREVIEW="${R_WEB_PREVIEW:-}"
R_E2E="${R_E2E:-}"
R_DEPS_ONLY="${R_DEPS_ONLY:-}"
R_HYGIENE="${R_HYGIENE:-}"
R_CAPACITY_PARITY="${R_CAPACITY_PARITY:-}"

cheap=false
if [ "$EVENT_NAME" = "pull_request" ] && [ "$FULL" = "false" ]; then
  cheap=true
fi

echo "mode=$([ "$cheap" = true ] && echo cheap || echo full) event=$EVENT_NAME full=$FULL"
echo "hygiene=$R_HYGIENE capacity-parity=$R_CAPACITY_PARITY changes=$R_CHANGES web-lint=$R_WEB_LINT web-typecheck=$R_WEB_TYPECHECK web-unit=$R_WEB_UNIT browser-test=$R_BROWSER_TEST preprocess-test=$R_PREPROCESS_TEST scripts-test=$R_SCRIPTS_TEST scanner-test=$R_SCANNER_TEST scanner-build=$R_SCANNER_BUILD crop-matrix=$R_CROP_MATRIX mask-parity=$R_MASK_PARITY wire-browser-url=$R_WIRE wire-preprocess-url=$R_WIRE_PREPROCESS wire-preprocess-capacity=$R_WIRE_CAPACITY e2e=$R_E2E deps_only=$R_DEPS_ONLY"

fail=0

# A merge group is always the full suite. A changes job that says otherwise is
# a bug in ci-mode, and passing on it could merge on cheap checks.
if [ "$EVENT_NAME" = "merge_group" ] && [ "$FULL" != "true" ]; then
  echo "::error::merge_group run reports full='$FULL' (must be true)"; fail=1
fi

# changes must SUCCEED (skipped => gate unreliable)
[ "$R_CHANGES" = "success" ] || { echo "::error::changes=$R_CHANGES (must succeed)"; fail=1; }
# repo-hygiene and capacity-parity are both ungated (always run, no path
# filter), so `skipped` is a fault, not out-of-scope, for either.
[ "$R_HYGIENE" = "success" ] || { echo "::error::repo-hygiene=$R_HYGIENE (must succeed)"; fail=1; }
[ "$R_CAPACITY_PARITY" = "success" ] || { echo "::error::capacity-parity=$R_CAPACITY_PARITY (must succeed)"; fail=1; }

if [ "$cheap" = true ]; then
  # Cheap PR run: the heavy jobs are skipped on purpose. They may not have
  # failed or been cancelled, and a skip is accepted only here.
  echo "cheap mode: preview, wiring, crop matrix, mask parity and e2e are skipped on purpose; the merge queue runs them."
  for kv in "e2e=$R_E2E" "preprocess-mask-parity=$R_MASK_PARITY"; do
    r="${kv#*=}"
    case "$r" in
      success|skipped) ;;
      *) echo "::error::${kv%%=*}=$r"; fail=1 ;;
    esac
  done
else
  # e2e must SUCCEED, except on a dependency-manifest-only PR where a SKIP is
  # the intended outcome (NEO-87). The deps_only check reads the same job
  # output that gated the skip, so the two can't disagree.
  if [ "$R_E2E" != "success" ]; then
    if [ "$R_DEPS_ONLY" = "true" ] && [ "$R_E2E" = "skipped" ]; then
      echo "e2e=skipped — dependency-manifest-only PR, matrix intentionally not run (NEO-87)."
    else
      echo "::error::e2e=$R_E2E (must succeed; skip allowed only when deps_only=true)"; fail=1
    fi
  fi
  # NEO-484: mask parity must SUCCEED whenever preprocess changed, deps-only
  # PRs included; a skip there would wave an unproven model path through.
  # Skipped is out-of-scope only when preprocess did not change.
  if [ "$R_PREPROCESS_CHANGED" = "true" ]; then
    [ "$R_MASK_PARITY" = "success" ] || { echo "::error::preprocess-mask-parity=$R_MASK_PARITY (must succeed when preprocess changed)"; fail=1; }
  else
    case "$R_MASK_PARITY" in
      success|skipped) ;;
      *) echo "::error::preprocess-mask-parity=$R_MASK_PARITY"; fail=1 ;;
    esac
  fi
fi

# area + wiring jobs: success OR skipped (out-of-area) OK; else fail.
# web-preview joins this list rather than getting a rule of its own (NEO-162):
# it is `skipped` exactly when deps_only skips E2E (or a cheap run), and any
# OTHER reason it fails to succeed already reds the gate through the e2e rule,
# since e2e `needs:` it.
for kv in "web-preview=$R_WEB_PREVIEW" "web-lint=$R_WEB_LINT" "web-typecheck=$R_WEB_TYPECHECK" "web-unit=$R_WEB_UNIT" "browser-test=$R_BROWSER_TEST" "preprocess-test=$R_PREPROCESS_TEST" "scripts-test=$R_SCRIPTS_TEST" "scanner-test=$R_SCANNER_TEST" "scanner-build=$R_SCANNER_BUILD" "preprocess-crop-matrix=$R_CROP_MATRIX" "wire-browser-url=$R_WIRE" "wire-preprocess-url=$R_WIRE_PREPROCESS" "wire-preprocess-capacity=$R_WIRE_CAPACITY"; do
  r="${kv#*=}"
  case "$r" in
    success|skipped) ;;
    *) echo "::error::${kv%%=*}=$r"; fail=1 ;;
  esac
done

[ "$fail" = "0" ] || { echo "CI Gate: FAIL"; exit 1; }
if [ "$cheap" = true ]; then
  echo "CI Gate: PASS (cheap) — the PR's cheap checks are green. This is NOT a merge verdict: the merge queue runs the full suite."
else
  echo "CI Gate: PASS — in-scope checks green, out-of-scope skipped."
fi
