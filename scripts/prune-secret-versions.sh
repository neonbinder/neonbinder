#!/usr/bin/env bash
#
# prune-secret-versions.sh — garbage-collect stale Secret Manager versions.
#
# WHY THIS EXISTS (NEO-115)
# -------------------------
# BSC sessions expire on a `TOKEN_TTL_MS` of one hour. Each expiry historically
# triggered a credential write-back that added a NEW secret version instead of
# reusing the existing one — and the write-back path did this twice per
# refresh: once to blank the stale token, then again to store the freshly
# minted one. So a single hourly expiry left two new ENABLED versions behind,
# and nothing ever destroyed the old ones. (Both writes are gone as of
# NEO-115 — the blanking write was pure waste, since the write-back that
# followed overwrote it moments later.)
#
# Measured 2026-08-04, across ALL secrets in each project: neonbinder-dev
# carried 1,326 ENABLED versions across 33 secrets (~$70/month) and growing
# ~25/day; prod (`neonbinder`) 27 versions across 11. Nine BSC credential
# secrets held 1,260 of dev's 1,326, so the credential-only scope this script
# now applies (see SCOPE below) still reclaims essentially all of it — but the
# exact retained counts differ from those totals, since infrastructure secrets
# are no longer swept. Re-run a dry-run for current figures.
#
# The write-back path is being fixed separately (NEO-115) to stop adding new
# accumulation. This script is the cleanup: a one-time sweep of the existing
# backlog, and a recurring backstop (see .github/workflows/secret-version-gc.yml)
# in case anything slips through again.
#
# Product decision: keep exactly ONE version per secret. These are short-lived
# marketplace tokens — there is no product need for version history, so the
# default is --keep 1.
#
# SAFETY MODEL
# ------------
#   * Only `*-credentials-*` secrets are in scope — see the SCOPE note above the
#     listing loop. Terraform-managed infrastructure secrets are never touched.
#   * Dry-run by default. Nothing is destroyed without --apply.
#   * The newest version of a secret is NEVER destroyed, regardless of --keep
#     — this is an unconditional guard, not just a consequence of the --keep
#     math. --keep 0 is rejected outright at the argument-parsing stage.
#   * Only ENABLED versions are considered. DESTROYED versions are left alone
#     (re-destroying one is a no-op error, not idempotent). Note this is
#     deliberately narrower than the in-code prune in secrets-manager.ts, which
#     also sweeps DISABLED — those still bill and still accept destroy. A
#     DISABLED version is not something this codebase ever creates, so the two
#     only diverge if one is made by hand; this script leaves it for a human.
#   * This script NEVER reads a secret payload. It only calls
#     `gcloud secrets versions list` (metadata: name, state, createTime) and
#     `gcloud secrets versions destroy`. It never calls
#     `gcloud secrets versions access`. Secret and version names are metadata,
#     not payloads, and are safe to print.
#   * A failed destroy is retried once, then reported — one stubborn version
#     must not abandon the rest of the sweep while the rest keep billing.
#     (Mirrors the retry-then-recheck pattern in cleanup-cloudrun-revisions.sh,
#     where `gcloud run revisions delete` was observed to crash client-side
#     while still completing the mutation server-side.)
#
set -euo pipefail

PROJECT=""
KEEP=1
APPLY=false

usage() {
  cat <<'USAGE'
Usage: prune-secret-versions.sh --project PROJECT [options]

  --project PROJECT   GCP project (required), e.g. neonbinder-dev
  --keep N            Retain the N newest ENABLED versions per secret
                       (default: 1). Must be >= 1 — the newest version of a
                       secret is never destroyed.
  --apply             Actually destroy. Without this, dry-run only.

Exit codes: 0 ok / 1 one or more destroys failed / 2 bad arguments
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --keep)    KEEP="$2";    shift 2 ;;
    --apply)   APPLY=true;   shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$PROJECT" ]] || { echo "ERROR: --project is required" >&2; usage; exit 2; }
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "ERROR: --keep must be a number" >&2; exit 2; }
[[ "$KEEP" -ge 1 ]] || { echo "ERROR: --keep must be >= 1 (the newest version of a secret is never destroyed)" >&2; exit 2; }

echo "project=$PROJECT keep=$KEEP apply=$APPLY"
echo

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/versions"

# SCOPE — only credential secrets are swept.
#
# `credKey()` in apps/web/convex/credentials.ts builds these as
# `${site}-credentials-${userId}`, and the two NEO-43 canaries as
# `${site}-credentials-canary`, so `*-credentials-*` matches every secret the
# accumulation bug can write to and nothing else.
#
# Everything else in the project is deliberately out of scope. `internal-api-key`
# and `anthropic-api-key` are Terraform-managed and load-bearing for Cloud Run
# startup; they are written by hand at a human cadence, so they never accumulate,
# and there is no reason for an automated destroy loop to be able to reach them.
# Matching the sweep's reach to its stated purpose means a fault in the plan
# arithmetic below cannot take out an infrastructure secret — a narrow blast
# radius by construction, rather than by the accident of `latest` happening to
# still resolve.
#
# Filtered here in the shell rather than via `gcloud --filter`: the API's `name`
# field is the full `projects/*/secrets/*` path, so a filter expression would be
# matching a different string than the one printed and destroyed below. A `case`
# glob over the exact value used everywhere else has no such gap.
#
# Zero matches is not an error — prod holds far fewer credential secrets than
# dev, and a project with none should report zero and exit clean.
MATCHED=0
SKIPPED=0

# One gcloud call per secret is unavoidable — Secret Manager has no bulk
# "list versions across all secrets" API. Metadata only, dumped to files so no
# JSON has to survive a round-trip through shell quoting or an oversized env
# var (some secrets here carry 200+ versions).
while IFS= read -r SECRET; do
  [[ -n "$SECRET" ]] || continue
  case "$SECRET" in
    *-credentials-*) MATCHED=$((MATCHED + 1)) ;;
    *) SKIPPED=$((SKIPPED + 1)); continue ;;
  esac
  gcloud secrets versions list "$SECRET" --project="$PROJECT" \
    --filter="state:ENABLED" --format=json > "$WORK/versions/$SECRET.json"
done < <(gcloud secrets list --project="$PROJECT" --format="value(name)")

echo "scope: *-credentials-* → $MATCHED secret(s) in scope, $SKIPPED skipped"
echo

# The plan is computed in Python: sorting by createTime and guarding the
# newest-version rule is too easy to get subtly wrong in shell, and getting it
# wrong here destroys a live credential. Python prints the report itself and
# drops one file per secret listing exactly which version numbers to destroy,
# for the apply phase below.
PROJECT="$PROJECT" KEEP="$KEEP" WORK="$WORK" python3 <<'PY'
import glob, json, os

work = os.environ["WORK"]
keep = int(os.environ["KEEP"])

secrets_with_work = []
total_enabled = 0
total_destroy = 0

paths = sorted(glob.glob(os.path.join(work, "versions", "*.json")))
print("── PER-SECRET REPORT ───────────────────────────────────────────────────")
for path in paths:
    secret = os.path.basename(path)[: -len(".json")]
    with open(path) as f:
        versions = json.load(f)

    # Defense in depth: re-filter to ENABLED even though --filter already did,
    # never trust a single layer when the failure mode is deleting a live cred.
    versions = [v for v in versions if v.get("state") == "ENABLED"]
    # gcloud's list order is not a documented contract — sort explicitly
    # rather than assume newest-first.
    versions.sort(key=lambda v: v["createTime"], reverse=True)

    destroy_list = versions[keep:]
    # Unconditional guard: the newest version is never in the destroy list,
    # no matter what --keep was passed.
    if versions:
        newest_name = versions[0]["name"]
        destroy_list = [v for v in destroy_list if v["name"] != newest_name]

    total_enabled += len(versions)
    total_destroy += len(destroy_list)
    print("  %-58s enabled=%-4d destroy=%-4d" % (secret, len(versions), len(destroy_list)))

    if destroy_list:
        secrets_with_work.append(secret)
        version_numbers = [v["name"].rsplit("/", 1)[-1] for v in destroy_list]
        with open(os.path.join(work, "destroy_%s.txt" % secret), "w") as f:
            f.write("\n".join(version_numbers))

print()
print("── TOTALS ──────────────────────────────────────────────────────────────")
print("secrets scanned      : %d" % len(paths))
print("enabled versions     : %d" % total_enabled)
print("versions to destroy  : %d" % total_destroy)
print("versions retained    : %d" % (total_enabled - total_destroy))
print()

with open(os.path.join(work, "secrets.txt"), "w") as f:
    f.write("\n".join(secrets_with_work))
PY

if [[ "$APPLY" != true ]]; then
  echo "DRY RUN — nothing changed. Re-run with --apply to execute."
  exit 0
fi

echo "Destroying versions..."
FAILED=0
while IFS= read -r SECRET; do
  [[ -n "$SECRET" ]] || continue
  DESTROY_FILE="$WORK/destroy_$SECRET.txt"
  [[ -f "$DESTROY_FILE" ]] || continue
  while IFS= read -r VERSION; do
    [[ -n "$VERSION" ]] || continue
    # Retry once, then re-check state before giving up — mirrors the pattern
    # in cleanup-cloudrun-revisions.sh for a client that crashes mid-mutation
    # while the server-side change still lands.
    if gcloud secrets versions destroy "$VERSION" --secret="$SECRET" \
         --project="$PROJECT" --quiet >/dev/null 2>&1; then
      echo "  destroyed $SECRET/$VERSION"
    elif [[ "$(gcloud secrets versions describe "$VERSION" --secret="$SECRET" \
         --project="$PROJECT" --format='value(state)' 2>/dev/null)" == "DESTROYED" ]]; then
      echo "  destroyed $SECRET/$VERSION (client error, confirmed server-side)"
    elif gcloud secrets versions destroy "$VERSION" --secret="$SECRET" \
         --project="$PROJECT" --quiet >/dev/null 2>&1; then
      echo "  destroyed $SECRET/$VERSION (on retry)"
    else
      echo "  FAILED  $SECRET/$VERSION" >&2
      FAILED=$((FAILED + 1))
    fi
  done < "$DESTROY_FILE"
done < "$WORK/secrets.txt"

echo
if [[ "$FAILED" -gt 0 ]]; then
  echo "Done, with $FAILED failure(s) — re-run to retry those." >&2
  exit 1
fi
echo "Done."
