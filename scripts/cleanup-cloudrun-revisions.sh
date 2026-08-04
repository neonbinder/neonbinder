#!/usr/bin/env bash
#
# cleanup-cloudrun-revisions.sh — garbage-collect stale Cloud Run revisions.
#
# WHY THIS EXISTS (NEO-114)
# -------------------------
# Cloud Run's `minScale` (min-instances) is a PER-REVISION annotation, and a
# revision holds a warm instance whenever it is minScale>=1 AND still
# addressable. A revision stays addressable while it carries a traffic TAG.
#
# browser.yml tags every deploy `sha-<short>` so the new revision can be probed
# at 0% traffic before promotion. Historically nothing ever removed that tag, and
# nothing ever deleted revisions — Cloud Run retains them indefinitely. Old
# revisions from before NEO-95 set `--min-instances=0` therefore stayed pinned at
# minScale=1 and each held an instance 24/7.
#
# Measured 2026-08-04: 17 pinned instances in dev (2 vCPU/4Gi each) and 10 in
# prod (1 vCPU/2Gi) — $869.63/month, ~90% of the entire GCP bill, versus $5.59
# of actual request compute.
#
# browser.yml now drops the sha tag as part of the promote step, so the leak is
# closed at the source. This script is the backstop: it reclaims anything that
# slips through (failed deploys that never promoted, abandoned PR previews).
#
# SAFETY MODEL
# ------------
#   * Dry-run by default. Nothing is deleted without --apply.
#   * The revision serving traffic is NEVER touched, at any percentage.
#   * The --keep N most recent revisions are retained for rollback.
#   * Tags are removed before deletion (a tagged revision cannot be deleted).
#   * A failed delete is retried once, then reported — one stubborn revision
#     must not abandon the rest of the sweep while they keep billing.
#
set -euo pipefail

PROJECT=""
SERVICE="neonbinder-browser"
REGION="us-central1"
KEEP=5
APPLY=false

usage() {
  cat <<'USAGE'
Usage: cleanup-cloudrun-revisions.sh --project PROJECT [options]

  --project PROJECT   GCP project (required), e.g. neonbinder-dev
  --service NAME      Cloud Run service (default: neonbinder-browser)
  --region REGION     Region (default: us-central1)
  --keep N            Retain the N most recent revisions (default: 5)
  --apply             Actually delete. Without this, dry-run only.

Exit codes: 0 ok / 1 one or more deletes failed / 2 bad arguments
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    --keep)    KEEP="$2";    shift 2 ;;
    --apply)   APPLY=true;   shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$PROJECT" ]] || { echo "ERROR: --project is required" >&2; usage; exit 2; }
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "ERROR: --keep must be a number" >&2; exit 2; }

echo "service=$SERVICE project=$PROJECT region=$REGION keep=$KEEP apply=$APPLY"
echo

SVC_JSON="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json)"
REV_JSON="$(gcloud run revisions list --service="$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json)"

# The plan is computed in Python: the tag/traffic/minScale correlation is too
# fiddly for shell, and getting it wrong here deletes a live revision. Python
# prints the report itself and drops two machine-readable files for the apply
# phase, so no JSON has to survive a round-trip through shell quoting.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SVC_JSON="$SVC_JSON" REV_JSON="$REV_JSON" KEEP="$KEEP" WORK="$WORK" python3 <<'PY'
import json, os

svc  = json.loads(os.environ["SVC_JSON"])
revs = json.loads(os.environ["REV_JSON"])
keep = int(os.environ["KEEP"])
work = os.environ["WORK"]

traffic = svc["status"].get("traffic", [])
# Any revision with a non-zero percent is live. Treat missing percent as 0.
serving = {t["revisionName"] for t in traffic if t.get("percent")}
tags    = {}
for t in traffic:
    if t.get("tag"):
        tags.setdefault(t["revisionName"], []).append(t["tag"])

# gcloud returns revisions newest-first; make that explicit rather than assumed.
revs.sort(key=lambda r: r["metadata"]["creationTimestamp"], reverse=True)
recent = {r["metadata"]["name"] for r in revs[:keep]}

protected, deletable = [], []
for r in revs:
    n  = r["metadata"]["name"]
    mn = int(r["metadata"]["annotations"].get("autoscaling.knative.dev/minScale", 0) or 0)
    res = r["spec"]["containers"][0].get("resources", {}).get("limits", {})
    row = {"name": n, "min": mn, "tags": tags.get(n, []),
           "cpu": res.get("cpu", "?"), "mem": res.get("memory", "?")}
    if n in serving:
        row["reason"] = "SERVING TRAFFIC"
        protected.append(row)
    elif n in recent:
        row["reason"] = "among %d most recent" % keep
        protected.append(row)
    else:
        deletable.append(row)

stale_tags = sorted({t for d in deletable for t in d["tags"]})
pinned     = [d for d in deletable if d["min"] > 0 and d["tags"]]

print("── PROTECTED ────────────────────────────────────────────────────────────")
for r in protected:
    print("  %-32s min=%d  %s" % (r["name"], r["min"], r["reason"]))
print()
print("── PINNED (tagged + minScale>0 → each holds a warm instance) ─────────────")
for r in pinned:
    print("  %-32s %s/%s  tags=%s" % (r["name"], r["cpu"], r["mem"], ",".join(r["tags"])))
if not pinned:
    print("  (none)")
print()
print("revisions to delete : %d" % len(deletable))
print("tags to remove      : %d" % len(stale_tags))
print("warm instances freed: %d" % len(pinned))
print()

with open(os.path.join(work, "tags.txt"), "w") as f:
    f.write(",".join(stale_tags))
with open(os.path.join(work, "revisions.txt"), "w") as f:
    f.write("\n".join(r["name"] for r in deletable))
PY

if [[ "$APPLY" != true ]]; then
  echo "DRY RUN — nothing changed. Re-run with --apply to execute."
  exit 0
fi

# Tags first: a tagged revision cannot be deleted. One update-traffic call keeps
# this to a single service mutation instead of N sequential ones.
STALE_TAGS="$(cat "$WORK/tags.txt")"
if [[ -n "$STALE_TAGS" ]]; then
  echo "Removing stale tags..."
  gcloud run services update-traffic "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --remove-tags="$STALE_TAGS"
else
  echo "No stale tags to remove."
fi

echo
echo "Deleting revisions..."
FAILED=0
while read -r REV; do
  [[ -n "$REV" ]] || continue
  # `gcloud run revisions delete` has been observed segfaulting mid-sweep while
  # still completing the delete server-side, so retry once and re-check rather
  # than trusting the exit code alone.
  if gcloud run revisions delete "$REV" \
       --project="$PROJECT" --region="$REGION" --quiet >/dev/null 2>&1; then
    echo "  deleted $REV"
  elif ! gcloud run revisions describe "$REV" \
       --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
    echo "  deleted $REV (client crashed, delete confirmed server-side)"
  elif gcloud run revisions delete "$REV" \
       --project="$PROJECT" --region="$REGION" --quiet >/dev/null 2>&1; then
    echo "  deleted $REV (on retry)"
  else
    echo "  FAILED  $REV" >&2
    FAILED=$((FAILED + 1))
  fi
done < "$WORK/revisions.txt"

echo
REMAINING_PINNED="$(gcloud run revisions list --service="$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --format="value(metadata.annotations['autoscaling.knative.dev/minScale'])" \
  | grep -c '^[1-9]' || true)"
echo "revisions still pinned at minScale>=1: $REMAINING_PINNED"

if [[ "$FAILED" -gt 0 ]]; then
  echo "Done, with $FAILED failure(s) — re-run to retry those." >&2
  exit 1
fi
echo "Done."
