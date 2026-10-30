#!/usr/bin/env bash
# NEO-392: delete a Convex PREVIEW deployment that the E2E seed found degraded
# (its reference import ran past NB_SEED_MAX_IMPORT_S). The next whole-workflow
# run rebuilds the Vercel preview, whose `npx convex deploy` creates a fresh
# Convex preview for the branch; recreate-degraded-preview.yml starts that
# re-run.
#
# Same guards as preview-cleanup.yml: refuse the shared deployments by name,
# then fail closed unless the Management API confirms `deploymentType ==
# preview`. Best-effort: never exits non-zero, so the caller decides the job's
# outcome; it sets the step output `deleted=true` only when the preview is gone.
#
# Env: CONVEX_NAME (the preview's deployment name), CONVEX_ACCESS_TOKEN (team
# token; the deployment-scoped preview deploy key cannot call the Management
# API).
set -uo pipefail

name="${CONVEX_NAME:-}"
if [ -z "$name" ]; then
  echo "No CONVEX_NAME — nothing to delete."
  exit 0
fi
if [ -z "${CONVEX_ACCESS_TOKEN:-}" ]; then
  echo "::warning::CONVEX_ACCESS_TOKEN not set — cannot delete degraded preview '$name'. Delete it by hand before re-running."
  exit 0
fi

case "$name" in
  first-starfish-800|focused-fox-53)
    echo "::error::refusing to delete non-preview deployment '$name'"
    exit 0 ;;
esac

dtype=$(curl -s --max-time 15 \
  -H "Authorization: Bearer $CONVEX_ACCESS_TOKEN" \
  "https://api.convex.dev/v1/deployments/$name" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('deploymentType',''))" \
  2>/dev/null || true)
if [ "$dtype" != "preview" ]; then
  echo "::error::refusing to delete '$name' — deploymentType='$dtype' is not a confirmed 'preview' (fail-closed)"
  exit 0
fi

status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X POST "https://api.convex.dev/v1/deployments/$name/delete" \
  -H "Authorization: Bearer $CONVEX_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}' || echo "000")
case "$status" in
  200) echo "Deleted degraded Convex preview '$name'. A whole-workflow re-run creates a fresh one."
       deleted=true ;;
  404) echo "Convex preview '$name' was already gone."
       deleted=true ;;
  *)   echo "::warning::Convex delete of '$name' returned HTTP $status — delete it by hand before re-running." ;;
esac
# Only a preview that is really gone earns the re-run marker; otherwise a
# re-run would land on the same slow preview.
if [ "${deleted:-}" = "true" ] && [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "deleted=true" >> "$GITHUB_OUTPUT"
fi
exit 0
