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
#   0  every serving or tagged revision's image exists and is protected
#   1  a SERVING or TAGGED revision's image is missing, or its pinned digest
#      is UNPROTECTED (see below)
#   2  usage/precondition error
#
# Idle revisions with missing images are reported but do NOT fail the run:
# they are dead rollback targets, worth knowing about, not an outage. A
# TAGGED revision with a missing image fails since NEO-484: a tag is an
# address something uses (a pr-<N> preview, a sha-<short> blue/green probe),
# and a missing image there breaks that address on its next cold start.
#
# PROTECTION (NEO-484)
#
# Since 2026-11-08 a `docker build` + push stores an OCI index, the image and
# an attestation, and Cloud Run pins the UNTAGGED image child. Existence alone
# therefore says nothing about tomorrow: an untagged digest is collected by
# the untagged-age cleanup policy unless something keeps it. Each serving or
# tagged pin is classified as one of:
#
#   tagged          the pinned version itself carries a tag
#   child-of-index  untagged, but listed by a TAGGED index in the same package
#                   (the parent index keeps it)
#   UNPROTECTED     neither: it will be collected by age. Fails the run.
#
# A pin whose only protecting tags start with `pr-` is warned about when the
# tagged version is older than PR_TAG_WARN_DAYS: the stale-pr- policy will
# collect it, and the revision with it.

set -uo pipefail

SERVICE=""
PROJECT=""
REGION="us-central1"
# The stale pr- cleanup policy deletes pr- tags at 14 days; warn 3 days ahead.
PR_TAG_WARN_DAYS="${PR_TAG_WARN_DAYS:-11}"

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

# Work dir for the gcloud JSON. A busy service (dev's neonbinder-preprocess has
# measured 400+KB of revision JSON) blows past Linux's per-string exec limit
# (MAX_ARG_STRLEN, ~128KiB) if that JSON is handed to python3 via an
# environment variable — execve then fails with E2BIG ("Argument list too
# long"), which bash reports as exit 126. Writing it to files and handing
# python3 only the (tiny) file PATHS avoids that ceiling entirely.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Revisions actually receiving traffic, and revisions addressable via a tag.
# Both matter, for different reasons:
#   - serving  → a missing image is an outage
#   - tagged   → a missing image breaks that tagged URL (PR previews, probes)
gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json 2>/dev/null \
  > "$WORK/svc.json" || {
  echo "ERROR: could not describe service $SERVICE in $PROJECT" >&2
  exit 2
}

gcloud run revisions list --service="$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json 2>/dev/null \
  > "$WORK/rev.json" || {
  echo "ERROR: could not list revisions for $SERVICE in $PROJECT" >&2
  exit 2
}

# Emits one "<revision>\t<image>\t<role>" line per revision.
# Fails closed: a malformed response raises rather than yielding an empty list,
# which would otherwise look like a clean bill of health.
MAPPING="$(WORK="$WORK" python3 2>"$WORK/mapping.err" <<'PY'
import json, os, sys

work = os.environ["WORK"]
with open(os.path.join(work, "svc.json")) as f:
    svc = json.load(f)
with open(os.path.join(work, "rev.json")) as f:
    revs = json.load(f)

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
)" || {
  echo "ERROR: failed to parse service/revision JSON (python3 exited $?):" >&2
  cat "$WORK/mapping.err" >&2
  exit 2
}

missing_serving=0
missing_tagged=0
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
    if [[ "$ROLE" != "idle" ]]; then
      printf '%s\t%s\t%s\n' "$REV" "$IMAGE" "$ROLE" >> "$WORK/pins.tsv"
    fi
  else
    if [[ "$ROLE" == "SERVING" ]]; then
      echo "  MISSING  $REV  (SERVING) — $IMAGE"
      missing_serving=$((missing_serving + 1))
    elif [[ "$ROLE" == "tagged" ]]; then
      echo "  MISSING  $REV  (tagged) — $IMAGE"
      missing_tagged=$((missing_tagged + 1))
    else
      echo "  missing  $REV  ($ROLE) — $IMAGE"
      missing_other=$((missing_other + 1))
    fi
  fi
done <<< "$MAPPING"

echo
echo "checked=$checked skipped=$skipped missing_serving=$missing_serving missing_tagged=$missing_tagged missing_other=$missing_other"

# ── Protection of every present serving/tagged pin ───────────────────────────
# One `artifacts docker images list` per package (tags + createTime + media
# type for every version), then the registry's own manifest endpoint for the
# tagged indexes, fetched only when an untagged pin needs a parent. All reads.
unprotected=0
pr_warn=0
if [[ -s "$WORK/pins.tsv" ]]; then
  echo
  echo "protection (PR_TAG_WARN_DAYS=$PR_TAG_WARN_DAYS):"
  WORK="$WORK" PROJECT="$PROJECT" PR_TAG_WARN_DAYS="$PR_TAG_WARN_DAYS" \
    python3 2>"$WORK/protect.err" > "$WORK/protect.out" <<'PY'
import json, os, subprocess, sys
from datetime import datetime, timezone

work = os.environ["WORK"]
project = os.environ["PROJECT"]
warn_days = float(os.environ["PR_TAG_WARN_DAYS"])
now = datetime.now(timezone.utc)
INDEX_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
)


def gcloud_json(*args):
    out = subprocess.run(
        ["gcloud", *args, "--format=json"], check=True, capture_output=True, text=True
    ).stdout
    return json.loads(out)


def parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


packages = {}  # package path -> {digest: {"tags": [...], "created": dt, "media": str}}
children = {}  # package path -> {child digest: [parent digest, ...]}
token = None


def versions(pkg):
    if pkg not in packages:
        rows = gcloud_json(
            "artifacts", "docker", "images", "list", pkg, "--include-tags", f"--project={project}"
        )
        packages[pkg] = {
            r["version"]: {
                "tags": [t for t in (r.get("tags") or []) if t],
                "created": parse_time(r["createTime"]),
                "media": (r.get("metadata") or {}).get("mediaType", ""),
            }
            for r in rows
        }
    return packages[pkg]


def index_children(pkg):
    global token
    if pkg in children:
        return children[pkg]
    if token is None:
        token = subprocess.run(
            ["gcloud", "auth", "print-access-token"], check=True, capture_output=True, text=True
        ).stdout.strip()
    host, path = pkg.split("/", 1)
    found = {}
    for digest, v in versions(pkg).items():
        if not v["tags"] or v["media"] not in INDEX_TYPES:
            continue
        # curl, not urllib: the token goes in a header read from stdin (-H @-)
        # so it never appears in argv, and tests can stub the binary.
        body = subprocess.run(
            ["curl", "-sf", "--max-time", "30", "-H", "@-",
             "-H", "Accept: " + ", ".join(INDEX_TYPES),
             f"https://{host}/v2/{path}/manifests/{digest}"],
            input=f"Authorization: Bearer {token}\n", check=True, capture_output=True, text=True,
        ).stdout
        for m in json.loads(body).get("manifests", []):
            found.setdefault(m["digest"], []).append(digest)
    children[pkg] = found
    return found


unprotected = pr_warn = 0
with open(os.path.join(work, "pins.tsv")) as f:
    pins = [line.rstrip("\n").split("\t") for line in f if line.strip()]

for rev, image, role in pins:
    desc = gcloud_json("artifacts", "docker", "images", "describe", image, f"--project={project}")
    fq = desc["image_summary"]["fully_qualified_digest"]
    pkg, digest = fq.split("@", 1)
    vs = versions(pkg)
    own = vs.get(digest)
    if own is None:
        raise SystemExit(f"{digest} described but absent from the {pkg} listing")
    if own["tags"]:
        kind, protectors = "tagged", [own]
    else:
        parents = [vs[p] for p in index_children(pkg).get(digest, []) if p in vs and vs[p]["tags"]]
        kind, protectors = ("child-of-index", parents) if parents else ("UNPROTECTED", [])
    tags = sorted({t for p in protectors for t in p["tags"]})
    note = ""
    if kind == "UNPROTECTED":
        unprotected += 1
        note = "  <- untagged and no tagged parent index: the untagged-age policy will collect it"
    elif tags and all(t.startswith("pr-") for t in tags):
        age = (now - max(p["created"] for p in protectors)).total_seconds() / 86400
        if age > warn_days:
            pr_warn += 1
            note = f"  <- WARN only pr- tags, {age:.1f} days old: the stale-pr- policy will collect it"
    shown = ",".join(tags[:4]) + (",..." if len(tags) > 4 else "") or "-"
    print(f"  {kind:<15} {rev}  ({role}) tags={shown} {digest[:19]}{note}")

print(f"RESULT unprotected={unprotected} pr_warn={pr_warn}")
PY
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "ERROR: protection check failed (python3 exited $rc):" >&2
    cat "$WORK/protect.err" >&2
    exit 2
  fi
  grep -v '^RESULT ' "$WORK/protect.out"
  result_line="$(grep '^RESULT ' "$WORK/protect.out" || true)"
  [[ -n "$result_line" ]] || { echo "ERROR: protection check produced no result" >&2; exit 2; }
  unprotected="$(sed -nE 's/.*unprotected=([0-9]+).*/\1/p' <<< "$result_line")"
  pr_warn="$(sed -nE 's/.*pr_warn=([0-9]+).*/\1/p' <<< "$result_line")"
  echo "unprotected=$unprotected pr_warn=$pr_warn"
fi

if [[ "$pr_warn" -gt 0 ]]; then
  echo
  echo "::warning::$pr_warn pinned image(s) are kept only by a pr- tag older than ${PR_TAG_WARN_DAYS} days."
fi

fail=0
if [[ "$missing_serving" -gt 0 ]]; then
  echo
  echo "FAIL: $missing_serving traffic-serving revision(s) reference an image that no longer exists."
  echo "      At minScale=0 this fails on the next cold start and cannot be repaired —"
  echo "      the revision pins a digest that is gone. Redeploy the service."
  fail=1
fi

if [[ "$missing_tagged" -gt 0 ]]; then
  echo
  echo "FAIL: $missing_tagged tagged revision(s) reference an image that no longer exists."
  echo "      The tagged URL fails on its next cold start. Redeploy that tag, or remove it."
  fail=1
fi

if [[ "$unprotected" -gt 0 ]]; then
  echo
  echo "FAIL: $unprotected serving or tagged revision(s) pin a digest that nothing protects."
  echo "      It is untagged and no tagged index lists it, so the untagged-age cleanup"
  echo "      policy will collect it. Retag that digest or redeploy the service."
  fail=1
fi

[[ "$fail" -eq 0 ]] || exit 1

if [[ "$missing_other" -gt 0 ]]; then
  echo
  echo "NOTE: $missing_other idle revision(s) have a collected image. Not an"
  echo "      outage — they are dead rollback targets. Expected for old revisions"
  echo "      once retention has aged their images out."
fi

echo "OK: every traffic-serving revision's image is present."
