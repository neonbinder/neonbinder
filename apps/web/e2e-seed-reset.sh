#!/bin/bash
# The reset half of the E2E seed (NEO-214, NEO-330). `npm run test:e2e:seed`
# and the CI `seed` / `seed-mobile` jobs run this, then the Playwright `setup`
# project. Ported from the retired run-e2e-smoke.sh `setup` slot.
#
# Unset NB_REFERENCE_BUNDLE: exactly `./e2e-baseline.sh reset`.
#
# NEO-330 - with NB_REFERENCE_BUNDLE set (a local path to a reference-seed
# bundle zip; CI downloads it and exports this), the reset becomes three steps:
# a structural check of the bundle, a reset that leaves the eight
# reference-seed tables alone, then the bundle's `convex import --replace`,
# which IS the clear for those eight and loads prod's reference catalogue in
# one atomic replace. Any step failing fails the run: a bad bundle stops
# before the reset touches anything, and a reset with no import after it
# leaves the previous pass's reference rows behind, which is not a baseline.
# The sequence is idempotent, so the mobile pass runs it again on the same
# deployment after the desktop shards have written to it.
#
# NB_REFERENCE_SEED_SUMMARY (CI only): a file path. When set, each step's
# wall-clock seconds, the bundle's generatedAt and its per-table row counts
# are appended as `label: value` lines, which the workflow copies verbatim
# into the step summary. Numbers, table names and the date only - never a
# row, a bundle path or a deployment name.
#
# Targeting, the production refusal and the consent gate are e2e-baseline.sh's
# and cli.mjs's own job; this script adds none of its own and bypasses none.
set -euo pipefail
cd "$(dirname "$0")"

reference_seed_summary() {
  if [ -n "${NB_REFERENCE_SEED_SUMMARY:-}" ]; then
    printf '%s: %s\n' "$1" "$2" >> "$NB_REFERENCE_SEED_SUMMARY"
  fi
}

# Prints `bundle generatedAt: <ISO date>` and `<table> rows: <n>` lines from
# the bundle's manifest.json - the structured JSON, not the CLI's log text, so
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

if [ -z "${NB_REFERENCE_BUNDLE:-}" ]; then
  echo "-- seed reset: scripted reset --"
  exec ./e2e-baseline.sh reset "$@"
fi

echo "-- seed reset: reference seed before the setup project (NEO-330) --"
# Check everything BEFORE the reset, so a missing or bad bundle, or a missing
# target, fails with the deployment untouched.
if [ ! -f "$NB_REFERENCE_BUNDLE" ]; then
  echo "x NB_REFERENCE_BUNDLE is set but is not a file - refusing to reset without a bundle to load after it." >&2
  exit 1
fi
if [ -z "${CONVEX_NAME:-}" ]; then
  echo "x NB_REFERENCE_BUNDLE is set but CONVEX_NAME is not - the reference-seed load needs an explicit deployment. Set CONVEX_NAME to the target deployment." >&2
  exit 1
fi
if ! node scripts/reference-seed/cli.mjs check "$NB_REFERENCE_BUNDLE"; then
  echo "x reference seed: the bundle fails its check - nothing was reset. Rebuild the bundle." >&2
  exit 1
fi
ref_manifest_lines="$(reference_seed_manifest_lines "$NB_REFERENCE_BUNDLE")"

# ONE target for both steps: the reset and the load each take
# `--deployment "$CONVEX_NAME"` explicitly, read once here. Neither is left to
# resolve its own default (.env.local, a deploy key), so the deployment the
# reset empties is provably the one the import fills - and the RESET consent
# e2e-baseline.sh asks for, against the name it prints, covers the import
# announced below as well.
ref_target="$CONVEX_NAME"
echo "   Next: reset ${ref_target} (everything except the reference catalogue), then"
echo "   import the reference catalogue, which replaces selectorOptions, leagues,"
echo "   franchises, teams, teamAliases, players, playerAliases and playerSports"
echo "   on ${ref_target}. Confirming the reset below confirms both."

# NEO-407: a hard limit on each Convex step. On 2026-10-31 a seed sat in this
# step for 28 minutes with no output (the CLI calls below have no timeout of
# their own), so a stalled preview held the job until its 45-minute timeout.
# With NB_SEED_HANG_S set (CI sets it), a step that runs past it is stopped and
# the script exits 75, the same "degraded preview" answer as a slow import:
# the caller deletes the preview and the workflow re-runs on a fresh one.
ref_guard() {
  if [ -n "${NB_SEED_HANG_S:-}" ]; then
    timeout --kill-after=15 "$NB_SEED_HANG_S" "$@"
  else
    "$@"
  fi
}
ref_hung() {
  # timeout(1) answers 124 when it stopped the command, 137 when it had to kill
  # it. A 137 before the limit (an OOM kill, say) is an ordinary failure.
  local waited=$(( $(date +%s) - $3 ))
  if [ -n "${NB_SEED_HANG_S:-}" ] && { [ "$1" -eq 124 ] || { [ "$1" -eq 137 ] && [ "$waited" -ge "$NB_SEED_HANG_S" ]; }; }; then
    echo "x reference seed: $2 did not finish within ${NB_SEED_HANG_S}s. ${ref_target} is degraded (NEO-407); stopping before any spec runs." >&2
    echo "reference seed: $2 stopped at $(date -u +%FT%TZ) after ${NB_SEED_HANG_S}s"
    exit 75
  fi
}

ref_t0=$(date +%s)
echo "reference seed: reset started $(date -u +%FT%TZ)"
ref_rc=0
ref_guard ./e2e-baseline.sh reset --except-reference-seed --deployment "$ref_target" || ref_rc=$?
ref_hung "$ref_rc" "the reset" "$ref_t0"
if [ "$ref_rc" -ne 0 ]; then
  echo "x reference seed: reset (except reference-seed tables) failed - see above." >&2
  exit 1
fi
ref_reset_s=$(( $(date +%s) - ref_t0 ))
echo "reference seed: reset took ${ref_reset_s}s"
reference_seed_summary "reset seconds" "$ref_reset_s"

ref_t1=$(date +%s)
echo "reference seed: load started $(date -u +%FT%TZ)"
ref_rc=0
ref_guard node scripts/reference-seed/cli.mjs load "$NB_REFERENCE_BUNDLE" \
    --deployment "$ref_target" --sports import --yes || ref_rc=$?
ref_hung "$ref_rc" "the reference load" "$ref_t1"
if [ "$ref_rc" -ne 0 ]; then
  echo "x reference seed: bundle load failed - see above. The deployment has been reset but holds no reference catalogue; do not run specs against it." >&2
  exit 1
fi
ref_import_s=$(( $(date +%s) - ref_t1 ))
echo "reference seed: import took ${ref_import_s}s"
# NEO-392: deployment + UTC window, the evidence a Convex support ticket needs.
echo "reference seed: import window ${ref_target} $(date -u -d "@${ref_t1}" +%FT%TZ 2>/dev/null || echo "${ref_t1}")..$(date -u +%FT%TZ)"
reference_seed_summary "import seconds" "$ref_import_s"

if [ -n "${NB_REFERENCE_SEED_SUMMARY:-}" ] && [ -n "$ref_manifest_lines" ]; then
  printf '%s\n' "$ref_manifest_lines" >> "$NB_REFERENCE_SEED_SUMMARY"
fi

# CI only: the bundle holds prod catalogue rows, so it does not outlive the
# step that needed it on a runner. A developer's local copy stays.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  rm -f "$NB_REFERENCE_BUNDLE"
fi

# NEO-392: a slow import marks a degraded preview. Across 387 CI seeds
# (10-13 to 10-30) the import took ~110s; every pass whose import ran past
# 500s went red, whatever the PR changed, and the slow spells stuck to one
# preview at a time. Set NB_SEED_MAX_IMPORT_S (CI does) to stop here with
# exit 75 instead of running shards against it; the caller deletes the
# preview so a re-run gets a fresh one.
if [ -n "${NB_SEED_MAX_IMPORT_S:-}" ] && [ "$ref_import_s" -gt "$NB_SEED_MAX_IMPORT_S" ]; then
  echo "x reference seed: import took ${ref_import_s}s, over the ${NB_SEED_MAX_IMPORT_S}s limit. ${ref_target} is degraded (NEO-392); stopping before any spec runs." >&2
  exit 75
fi
