#!/usr/bin/env bash
#
# Detect Cloud Run revisions whose container image no longer exists in Artifact
# Registry (NEO-130).
#
# WHY THIS EXISTS
#
# A Cloud Run revision immutably pins the image DIGEST it was deployed with.
# Every revision here runs minScale=0, so nothing is holding the image in a
# running container — if an AR cleanup policy collects that digest, the revision
# is dead: the next request cold-starts against a missing image and fails, and
# the revision cannot be repaired, only replaced.
#
# That has already happened once (neonbinder-browser-00001-47f in prod) and it
# failed silently — nothing watches for it. This script is that watch.
#
# It is READ-ONLY. It never deletes or modifies anything.
#
# EXIT CODES
#   0  every image backing a traffic-serving revision still exists
#   1  a SERVING revision's image is missing (actionable: that service is one
#      cold start away from failing, or already failing)
#   2  usage/precondition error
#
# Non-serving revisions with missing images are reported but do NOT fail the
# run: they are dead rollback targets, worth knowing about, not an outage.

set -uo pipefail

SERVICE=""
PROJECT=""
REGION="us-central1"

usage() {
  cat <<'EOF'
Usage: check-revision-images.sh --project PROJECT --service SERVICE [--region REGION]

  --project PROJECT   GCP project (required)
  --service SERVICE   Cloud Run service (required — deliberately NOT defaulted,
                      so a new service cannot be silently skipped)
  --region REGION     Cloud Run region (default: us-central1)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --region)  REGION="${2:-}";  shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$PROJECT" ]] || { echo "ERROR: --project is required" >&2; usage; exit 2; }
[[ -n "$SERVICE" ]] || { echo "ERROR: --service is required" >&2; usage; exit 2; }

echo "service=$SERVICE project=$PROJECT region=$REGION"
echo

# Revisions actually receiving traffic, and revisions addressable via a tag.
# Both matter, for different reasons:
#   - serving  → a missing image is an outage
#   - tagged   → a missing image breaks that tagged URL (PR previews, probes)
SVC_JSON="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json 2>/dev/null)" || {
  echo "ERROR: could not describe service $SERVICE in $PROJECT" >&2
  exit 2
}

REV_JSON="$(gcloud run revisions list --service="$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json 2>/dev/null)" || {
  echo "ERROR: could not list revisions for $SERVICE in $PROJECT" >&2
  exit 2
}

# Emits one "<revision>\t<image>\t<role>" line per revision.
# Fails closed: a malformed response raises rather than yielding an empty list,
# which would otherwise look like a clean bill of health.
MAPPING="$(SVC_JSON="$SVC_JSON" REV_JSON="$REV_JSON" python3 <<'PY'
import json, os, sys

svc = json.loads(os.environ["SVC_JSON"])
revs = json.loads(os.environ["REV_JSON"])

traffic = svc["status"].get("traffic", [])
serving = {t["revisionName"] for t in traffic if t.get("percent")}
tagged = {t["revisionName"] for t in traffic if t.get("tag")}

for r in revs:
    name = r["metadata"]["name"]
    # status.imageDigest is the RESOLVED digest — Cloud Run pins the digest at
    # deploy time even when the deploy referenced a tag, so this is the thing
    # that actually has to still exist.
    image = (r.get("status") or {}).get("imageDigest") or ""
    if not image:
        image = r["spec"]["containers"][0].get("image", "")
    if name in serving:
        role = "SERVING"
    elif name in tagged:
        role = "tagged"
    else:
        role = "idle"
    print(f"{name}\t{image}\t{role}")
PY
)" || { echo "ERROR: failed to parse service/revision JSON" >&2; exit 2; }

missing_serving=0
missing_other=0
checked=0
skipped=0

while IFS=$'\t' read -r REV IMAGE ROLE; do
  [[ -n "$REV" ]] || continue

  if [[ -z "$IMAGE" ]]; then
    echo "  ?        $REV  ($ROLE) — no image recorded"
    continue
  fi

  # Only check images in THIS project's registry. Bootstrap revisions reference
  # Google-hosted images (e.g. gcr.io/cloudrun/hello) which we neither own nor
  # can collect; checking them would produce a permanent false positive.
  if [[ "$IMAGE" != *"/${PROJECT}/"* ]]; then
    echo "  skip     $REV  ($ROLE) — external image ${IMAGE%%@*}"
    skipped=$((skipped + 1))
    continue
  fi

  checked=$((checked + 1))
  if gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT" >/dev/null 2>&1; then
    echo "  ok       $REV  ($ROLE)"
  else
    if [[ "$ROLE" == "SERVING" ]]; then
      echo "  MISSING  $REV  (SERVING) — $IMAGE"
      missing_serving=$((missing_serving + 1))
    else
      echo "  missing  $REV  ($ROLE) — $IMAGE"
      missing_other=$((missing_other + 1))
    fi
  fi
done <<< "$MAPPING"

echo
echo "checked=$checked skipped=$skipped missing_serving=$missing_serving missing_other=$missing_other"

if [[ "$missing_serving" -gt 0 ]]; then
  echo
  echo "FAIL: $missing_serving traffic-serving revision(s) reference an image that no longer exists."
  echo "      At minScale=0 this fails on the next cold start and cannot be repaired —"
  echo "      the revision pins a digest that is gone. Redeploy the service."
  exit 1
fi

if [[ "$missing_other" -gt 0 ]]; then
  echo
  echo "NOTE: $missing_other non-serving revision(s) have a collected image. Not an"
  echo "      outage — they are dead rollback targets. Expected for old revisions"
  echo "      once retention has aged their images out."
fi

echo "OK: every traffic-serving revision's image is present."
