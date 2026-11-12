#!/usr/bin/env bash
#
# Wait until the revision behind a tag on a preprocess Cloud Run service was
# built from a given commit (NEO-484; the guard NEO-191 first wrote inline).
#
# preprocess.yml's deploy-preview and deploy-preview-fast stamp every pr-<N>
# revision with PREVIEW_SHA=<PR head sha>. A URL that merely answers is not
# proof: on any second-or-later push the tag still points at the PREVIOUS
# push's revision until the new image has built and deployed. Anything that
# asserts against the revision (the crop matrix, E2E through
# wire-preprocess-url) must wait on this, not on the URL.
#
# Usage:
#   wait-preprocess-revision.sh --project P --service S --tag T --sha SHA
#       [--attempts N] [--interval SECONDS]
#
# Polls up to N times (default 120) every SECONDS (default 20). A transient
# gcloud/API error costs one poll, not the job. On timeout it prints an
# ::error:: naming the service, tag, wanted sha and the last value seen, and
# exits 1: it never falls through to the stale revision.
#
# Exit: 0 revision carries PREVIEW_SHA == SHA, 1 timed out, 2 usage error.

set -euo pipefail

project="" service="" tag="" sha="" attempts=120 interval=20
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)  project="${2:-}"; shift 2 ;;
    --service)  service="${2:-}"; shift 2 ;;
    --tag)      tag="${2:-}"; shift 2 ;;
    --sha)      sha="${2:-}"; shift 2 ;;
    --attempts) attempts="${2:-}"; shift 2 ;;
    --interval) interval="${2:-}"; shift 2 ;;
    *) echo "usage error: unknown arg $1" >&2; exit 2 ;;
  esac
done
[[ -n "$project" && -n "$service" && -n "$tag" && -n "$sha" ]] \
  || { echo "usage error: --project, --service, --tag and --sha are required" >&2; exit 2; }
[[ "$attempts" =~ ^[0-9]+$ && "$interval" =~ ^[0-9]+$ ]] \
  || { echo "usage error: --attempts and --interval must be integers" >&2; exit 2; }

last="<no revision yet>"
for attempt in $(seq 1 "$attempts"); do
  # `|| true` on both reads: see the header.
  rev=$(gcloud run services describe "$service" \
    --region=us-central1 --project="$project" --format=json 2>/dev/null \
    | jq -r --arg t "$tag" '.status.traffic[]? | select(.tag==$t) | .revisionName' || true)
  if [[ -n "$rev" && "$rev" != "null" ]]; then
    actual=$(gcloud run revisions describe "$rev" \
      --region=us-central1 --project="$project" --format=json 2>/dev/null \
      | jq -r '.spec.containers[0].env[]? | select(.name=="PREVIEW_SHA") | .value' || true)
    if [[ "$actual" == "$sha" ]]; then
      echo "$service $tag -> $rev is built from $sha"
      exit 0
    fi
    last="$rev has PREVIEW_SHA='${actual:-<unset>}'"
    echo "attempt $attempt/$attempts: $service $last, want $sha, retry in ${interval}s"
  else
    last="no revision serves tag $tag"
    echo "attempt $attempt/$attempts: $service has no revision serving tag $tag yet, retry in ${interval}s"
  fi
  [[ "$attempt" -lt "$attempts" ]] && sleep "$interval"
done
echo "::error::$service tag $tag never served a revision built from $sha (last seen: $last). preprocess.yml deploy-preview / deploy-preview-fast may have failed or been cancelled; E2E is not run against a stale revision."
exit 1
