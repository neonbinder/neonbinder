#!/bin/bash
# ─── The reset in front of the scripted seed (NEO-214, NEO-330, NEO-339) ─────
# The one place the E2E seed empties its deployment. Both seed entry points go
# through it, so they cannot drift:
#   - local: ./e2e-seed.sh (`npm run test:e2e -- setup`, `npm run e2e:local:seed`)
#   - CI:    e2e.yml's `seed` job, before `setbuild apply`
#
# Unset NB_REFERENCE_BUNDLE: the full scripted reset (`e2e-baseline.sh reset`).
#
# NB_REFERENCE_BUNDLE set (a local path to a reference-seed bundle zip; CI
# downloads it and exports this): three steps instead —
#   1. a structural check of the bundle (`scripts/reference-seed/cli.mjs check`);
#   2. a reset that leaves the eight reference-seed tables alone
#      (`e2e-baseline.sh reset --except-reference-seed`);
#   3. the bundle's `convex import --replace`, which IS the clear for those
#      eight and loads prod's reference catalogue in one atomic replace
#      (docs/operations/neo330-reference-seed.md).
# Any step failing fails the seed: a bad bundle stops before the reset touches
# anything, and a reset with no import after it leaves the previous run's
# reference rows behind, which is not a baseline. The setbuild apply that
# follows then runs against a deployment that already knows prod's players,
# teams and leagues, so its review asks only about names the catalogue lacks
# (and about same-name players, the pick step) — the spec's answers for every
# other name are moot no-ops.
#
# NB_REFERENCE_SEED_SUMMARY (CI only): a file path. When set, each step's
# wall-clock seconds, the bundle's generatedAt and its per-table row counts
# are appended as `label: value` lines, which the workflow copies verbatim
# into the step summary. Numbers, table names and the date only — never a
# row, a bundle path or a deployment name.
#
# Usage:  ./e2e-reset-for-seed.sh --deployment <slug>
# The deployment is REQUIRED and passed explicitly to every step (reset and
# load alike), so the deployment the reset empties is provably the one the
# import fills — and the RESET consent e2e-baseline.sh asks for, against the
# name it prints, covers the import announced below as well. Every guard of
# e2e-baseline.sh (refuses prod, CI-vs-interactive confirmation) and of
# cli.mjs (refuses prod, deploy-key shape) applies unchanged.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"; cd "$ROOT"

TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deployment)
      [ $# -ge 2 ] || { echo "✗ --deployment needs a value" >&2; exit 2; }
      TARGET="$2"; shift 2 ;;
    --deployment=*) TARGET="${1#--deployment=}"; shift ;;
    *) echo "✗ unknown argument: $1 (usage: ./e2e-reset-for-seed.sh --deployment <slug>)" >&2; exit 2 ;;
  esac
done
[ -n "$TARGET" ] || { echo "✗ --deployment <slug> is required" >&2; exit 2; }

if [ -z "${NB_REFERENCE_BUNDLE:-}" ]; then
  echo "── scripted reset (e2e-baseline.sh reset --deployment $TARGET) ──"
  exec ./e2e-baseline.sh reset --deployment "$TARGET"
fi

reference_seed_summary() {
  if [ -n "${NB_REFERENCE_SEED_SUMMARY:-}" ]; then
    printf '%s: %s\n' "$1" "$2" >> "$NB_REFERENCE_SEED_SUMMARY"
  fi
}

# Prints `bundle generatedAt: <ISO date>` and `<table> rows: <n>` lines from
# the bundle's manifest.json — the structured JSON, not the CLI's log text, so
# a change to the log wording cannot break it. Every value is validated
# (ISO timestamp, letters-only table name, safe integer) and anything else is
# dropped, so nothing but a date, table names and numbers can reach the
# summary. Best-effort: it prints nothing rather than failing the run. Only
# called after `cli.mjs check` passed, and that check already proves the
# manifest's counts agree with the rows.
reference_seed_manifest_lines() {
  unzip -p "$1" manifest.json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      const out = [];
      if (typeof m.generatedAt === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(m.generatedAt)) {
        out.push(`bundle generatedAt: ${m.generatedAt}`);
      }
      for (const [t, n] of Object.entries(m.counts ?? {})) {
        if (/^[A-Za-z]+$/.test(t) && Number.isSafeInteger(n) && n >= 0) {
          out.push(`${t} rows: ${n}`);
        }
      }
      if (out.length) process.stdout.write(out.join("\n") + "\n");
    });
  ' 2>/dev/null || true
}

echo "── reference seed before the scripted seed (NEO-330) ──"
# Check everything BEFORE the reset, so a missing or bad bundle fails with the
# deployment untouched.
if [ ! -f "$NB_REFERENCE_BUNDLE" ]; then
  echo "✗ NB_REFERENCE_BUNDLE is set but is not a file — refusing to reset without a bundle to load after it." >&2
  exit 1
fi
if ! node scripts/reference-seed/cli.mjs check "$NB_REFERENCE_BUNDLE"; then
  echo "✗ reference seed: the bundle fails its check — nothing was reset. Rebuild the bundle." >&2
  exit 1
fi
ref_manifest_lines="$(reference_seed_manifest_lines "$NB_REFERENCE_BUNDLE")"

echo "   Next: reset ${TARGET} (everything except the reference catalogue), then"
echo "   import the reference catalogue, which replaces selectorOptions, leagues,"
echo "   franchises, teams, teamAliases, players, playerAliases and playerSports"
echo "   on ${TARGET}. Confirming the reset below confirms both."

ref_t0=$(date +%s)
if ! ./e2e-baseline.sh reset --except-reference-seed --deployment "$TARGET"; then
  echo "✗ reference seed: reset (except reference-seed tables) failed — see above." >&2
  exit 1
fi
ref_reset_s=$(( $(date +%s) - ref_t0 ))
echo "⏱ reference seed: reset took ${ref_reset_s}s"
reference_seed_summary "reset seconds" "$ref_reset_s"

ref_t1=$(date +%s)
if ! node scripts/reference-seed/cli.mjs load "$NB_REFERENCE_BUNDLE" \
    --deployment "$TARGET" --sports import --yes; then
  echo "✗ reference seed: bundle load failed — see above. The deployment has been reset but holds no reference catalogue; do not run flows against it." >&2
  exit 1
fi
ref_import_s=$(( $(date +%s) - ref_t1 ))
echo "⏱ reference seed: import took ${ref_import_s}s"
reference_seed_summary "import seconds" "$ref_import_s"
if [ -n "${NB_REFERENCE_SEED_SUMMARY:-}" ] && [ -n "$ref_manifest_lines" ]; then
  printf '%s\n' "$ref_manifest_lines" >> "$NB_REFERENCE_SEED_SUMMARY"
fi

# CI only: the bundle holds prod catalogue rows, so it does not outlive the
# step that needed it on a runner. A developer's local copy stays.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  rm -f "$NB_REFERENCE_BUNDLE"
fi
