// Test doubles for `gcloud`, `python3` and (NEO-484) `curl`, used to exercise
// cleanup-cloudrun-revisions.sh / check-revision-images.sh without touching
// real GCP and without depending on Linux's exec() argument-size limit being
// present on the machine running the test (it isn't, on macOS).
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REAL_PYTHON3 = execFileSync("/bin/sh", ["-c", "command -v python3"])
  .toString()
  .trim();

// Linux's execve() rejects any single argv/envp string longer than
// MAX_ARG_STRLEN (~128 KiB, see execve(2)) with E2BIG, which the shell that
// tried to exec python3 reports as exit 126. macOS enforces no such per-string
// limit (only a much larger total), so the real bug (NEO-309) cannot be
// reproduced on a Mac by size alone. This stub enforces the Linux limit
// itself — on every environment string, matching what CI's runners actually
// do — then delegates to the real python3. That makes the test meaningful on
// any OS: a script that still shovels big JSON through an env var into
// python3 fails here exactly as it fails in CI; a script that only ever
// passes small values (like a temp-file path) never trips it.
const PYTHON3_STUB = `#!/usr/bin/env bash
set -eo pipefail
LIMIT=131072
while IFS= read -r -d '' entry; do
  value="\${entry#*=}"
  if [ "\${#value}" -gt "$LIMIT" ]; then
    echo "python3: execve: Argument list too long" >&2
    exit 126
  fi
done < <(env -0)
exec "${REAL_PYTHON3}" "$@"
`;

// Dispatches on the real `gcloud` CLI's positional verb shape. Reads its
// canned responses from small files (paths, not payloads, are all this stub
// ever receives via env) so the fixture JSON itself never crosses an
// env/argv boundary here either.
const GCLOUD_STUB = `#!/usr/bin/env bash
set -eo pipefail

case "\${1:-}" in
  run)
    case "\${2:-}" in
      services)
        case "\${3:-}" in
          describe) cat "$GCLOUD_STUB_SVC_FILE"; exit 0 ;;
          update-traffic) exit 0 ;;
        esac
        ;;
      revisions)
        case "\${3:-}" in
          list) cat "$GCLOUD_STUB_REV_FILE"; exit 0 ;;
          delete) exit 0 ;;
          describe) exit 0 ;;
        esac
        ;;
    esac
    ;;
  artifacts)
    # gcloud artifacts docker images describe IMAGE --project=PROJECT [--format=json]
    # gcloud artifacts docker images list PACKAGE --include-tags --format=json
    VERB="\${4:-}"
    IMAGE=""
    FORMAT_JSON=""
    for arg in "$@"; do
      case "$arg" in
        --format=json) FORMAT_JSON=1 ;;
        --*|artifacts|docker|images|describe|list) : ;;
        *) IMAGE="$arg" ;;
      esac
    done
    if [ "$VERB" = "list" ]; then
      # NEO-484: canned version listing (tags, createTime, mediaType).
      if [ -n "\${GCLOUD_STUB_VERSIONS_FILE:-}" ]; then cat "$GCLOUD_STUB_VERSIONS_FILE"; else echo "[]"; fi
      exit 0
    fi
    MISSING=",\${GCLOUD_STUB_MISSING_IMAGES:-},"
    case "$MISSING" in
      *",$IMAGE,"*) exit 1 ;;
    esac
    if [ -n "$FORMAT_JSON" ]; then
      # The fixtures' image refs are already fully qualified.
      printf '{"image_summary":{"fully_qualified_digest":"%s"}}\n' "$IMAGE"
    fi
    exit 0
    ;;
  auth)
    [ "\${2:-}" = "print-access-token" ] && { echo "stub-token"; exit 0; }
    ;;
esac

echo "gcloud stub: unhandled invocation: $*" >&2
exit 3
`;

// NEO-484: registry manifest reads. Answers GET .../manifests/<digest> from
// $CURL_STUB_INDEX_DIR/<digest>.json, and fails (exit 22, curl -f) otherwise.
const CURL_STUB = `#!/usr/bin/env bash
set -eo pipefail
cat >/dev/null   # the Authorization header arrives on stdin (-H @-)
URL=""
for arg in "$@"; do
  case "$arg" in
    https://*) URL="$arg" ;;
  esac
done
DIGEST="\${URL##*/manifests/}"
F="\${CURL_STUB_INDEX_DIR:-/nonexistent}/\${DIGEST}.json"
[ -f "$F" ] || exit 22
cat "$F"
`;

// Environment keys that must never reach the child: an exported shell
// function (BASH_FUNC_gcloud%%=, BASH_FUNC_python3%%=) or a BASH_ENV startup
// file can define a function named `gcloud`/`python3` that bash resolves
// *before* consulting PATH, silently bypassing the stub in this file and
// running the real CLI instead — and, verified empirically, bash honors
// both regardless of --norc/--noprofile (those flags only govern
// interactive/login startup files; BASH_ENV and inherited BASH_FUNC_*
// exports are a separate, always-on mechanism for non-interactive shells).
// This is the load-bearing guard; run-script.mjs's `bash --norc --noprofile`
// is a secondary one for the startup-file path this doesn't otherwise touch.
function withoutShellFunctionEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "BASH_ENV" || key.startsWith("BASH_FUNC_")) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Writes svc.json / rev.json fixture files plus stub `gcloud` and `python3`
 * executables into a fresh temp bin dir, and returns everything a test needs
 * to run a script against them.
 */
export function makeStubEnv({ service, svc, rev, missingImages = [], versions, indexes = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "nb-revscript-stub-"));

  const svcFile = join(dir, "svc.json");
  const revFile = join(dir, "rev.json");
  writeFileSync(svcFile, JSON.stringify(svc));
  writeFileSync(revFile, JSON.stringify(rev));

  const gcloudPath = join(dir, "gcloud");
  writeFileSync(gcloudPath, GCLOUD_STUB);
  chmodSync(gcloudPath, 0o755);

  // NEO-484: optional Artifact Registry state for check-revision-images.sh's
  // protection pass. `versions` is the `images list` JSON; `indexes` maps an
  // index digest to its manifest JSON.
  const versionsFile = join(dir, "versions.json");
  if (versions) writeFileSync(versionsFile, JSON.stringify(versions));
  const indexDir = join(dir, "indexes");
  mkdirSync(indexDir);
  for (const [digest, manifest] of Object.entries(indexes)) {
    writeFileSync(join(indexDir, `${digest}.json`), JSON.stringify(manifest));
  }
  const curlPath = join(dir, "curl");
  writeFileSync(curlPath, CURL_STUB);
  chmodSync(curlPath, 0o755);

  const python3Path = join(dir, "python3");
  writeFileSync(python3Path, PYTHON3_STUB);
  chmodSync(python3Path, 0o755);

  return {
    dir,
    svcFile,
    revFile,
    env: withoutShellFunctionEnv({
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GCLOUD_STUB_SVC_FILE: svcFile,
      GCLOUD_STUB_REV_FILE: revFile,
      GCLOUD_STUB_MISSING_IMAGES: missingImages.join(","),
      ...(versions ? { GCLOUD_STUB_VERSIONS_FILE: versionsFile } : {}),
      CURL_STUB_INDEX_DIR: indexDir,
    }),
  };
}
