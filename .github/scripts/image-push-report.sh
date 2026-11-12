#!/usr/bin/env bash
#
# After `docker push REF`: assert REF is ONE image manifest, then write the
# image's size and `docker history` to the job summary (NEO-484).
#
# Why the assertion: since 2026-11-08 the runner's builder pushed an OCI index
# plus an attestation by default. Cloud Run then pins the untagged image
# child, which survives the untagged cleanup policy only while its tagged
# parent index does, and each push costs ~3 package versions against the
# keep_count window. Every build passes `--provenance=false --sbom=false`;
# this check fails the job if a builder change ever brings the index back.
#
# Usage: image-push-report.sh REF   (REF is name:tag, already pushed)

set -euo pipefail

ref="${1:?usage: image-push-report.sh REF}"

raw="$(docker buildx imagetools inspect --raw "$ref")"
media="$(jq -r '.mediaType // "<none>"' <<< "$raw")"
if jq -e 'has("manifests")' <<< "$raw" >/dev/null || ! jq -e '.config.digest' <<< "$raw" >/dev/null; then
  echo "::error::$ref was pushed as $media, not a single image manifest. Build with --provenance=false --sbom=false (NEO-484)."
  exit 1
fi
digest="$(docker buildx imagetools inspect "$ref" | awk '/^Digest:/{print $2; exit}')"
pushed_bytes="$(jq '[.layers[].size] | add' <<< "$raw")"
local_bytes="$(docker image inspect --format '{{.Size}}' "$ref")"
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }

echo "ok: $ref is a single $media ($digest)"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Image \`$ref\`"
    echo
    echo "- Manifest: \`$media\`, digest \`$digest\`"
    echo "- Pushed (compressed layers): $(human "$pushed_bytes")"
    echo "- Unpacked: $(human "$local_bytes")"
    echo
    echo '<details><summary>docker history</summary>'
    echo
    echo '```'
    docker history --format 'table {{.Size}}\t{{.CreatedBy}}' "$ref" | cut -c1-200
    echo '```'
    echo '</details>'
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi
