#!/usr/bin/env bash
# NEO-289 / NEO-330: report how much of the seed's enrichment name set the
# fixture recording covered, without ever failing the job.
#
# Called by e2e.yml (seed, seed-mobile, report) so the three call sites cannot
# drift. Env: CONVEX_DEPLOY_KEY, CONVEX_NAME (required, the caller has already
# skipped when either is missing), COVERAGE_LABEL (summary heading),
# COVERAGE_SINCE_MS (optional; bounds which rows count as "looked up by this
# run", beats the backend's first-year-row inference). Run from apps/web.
# Always exits 0: coverage drifting is an operator signal, not a CI failure.
set -uo pipefail

COVERAGE_LABEL="${COVERAGE_LABEL:-}"
args=$(python3 -c '
import json, os
a = {"sportQid": "Q5369", "confirm": "CAPTURE_ENRICHMENT_FIXTURES"}
s = os.environ.get("COVERAGE_SINCE_MS", "")
if s.isdigit():
    a["since"] = int(s)
print(json.dumps(a))
')
out=$(mktemp); err=$(mktemp); md=$(mktemp)
# stdout is the result alone (JSON.stringify(result, null, 2) off a TTY, so
# several lines); function logs and CLI chatter go to stderr.
npx --yes convex@1.39.1 run enrichmentFixtures:coverageReportFromCli \
  "$args" --deployment "$CONVEX_NAME" >"$out" 2>"$err"
status=$?
cat "$err"
cat "$out"
if [ $status -ne 0 ]; then
  # Name the cause: a missing function means the Convex side is not on this
  # preview yet; anything else is a real error to look at.
  case "$(cat "$err" "$out")" in
    *"Could not find"*|*"not found"*|*"does not exist"*)
      why="function not on this preview yet (Convex side not deployed here)";;
    *)
      why="coverage action returned an error";;
  esac
  echo "::warning::Enrichment fixture coverage report (${COVERAGE_LABEL}) could not be run — ${why}. See job log for details."
  {
    echo "### Enrichment fixture coverage, ${COVERAGE_LABEL} (NEO-289)"
    echo "- Could not run \`enrichmentFixtures:coverageReportFromCli\` — ${why}; see job log."
  } >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi
# Parse ALL of stdout as one JSON document. Annotations go to stdout (workflow
# commands); the summary markdown goes to $md. Names only, never row contents.
# A parse miss never fails the job.
COVERAGE_LABEL="$COVERAGE_LABEL" python3 - "$out" "$md" <<'PY'
import json, os, sys
label = os.environ.get("COVERAGE_LABEL", "")
def clean(x):
    return str(x).replace("%", "%25").replace("\r", " ").replace("\n", " ")
try:
    d = json.load(open(sys.argv[1]))
    covered = d["covered"]
    missing = [str(m) for m in d.get("missing", [])]
    truncated = bool(d.get("truncated"))
    tsrc = [str(t) for t in d.get("truncatedSources", [])]
    total, since, ssrc = d.get("total"), d.get("since"), d.get("sinceSource")
except Exception as e:
    print("::warning::Enrichment fixture coverage (%s): could not parse the report (%s)." % (label, clean(type(e).__name__)))
    open(sys.argv[2], "w").write("- Report could not be parsed; see job log.\n")
    sys.exit(0)
lines = [
    "- covered: `%s`" % covered,
    "- total looked-up names: `%s`" % total,
    "- missing: `%s`" % (", ".join(missing) or "<none>"),
    "- since: `%s` (source: `%s`)" % (since, ssrc),
]
if truncated:
    lines.append("- **truncated** sources: `%s`" % (", ".join(tsrc) or "<unnamed>"))
    print("::warning::Enrichment fixture coverage (%s) is truncated, so covered/missing describe only the rows read. Truncated sources: %s" % (label, clean(", ".join(tsrc) or "<unnamed>")))
if missing:
    shown = missing[:100]
    extra = " (+%d more)" % (len(missing) - 100) if len(missing) > 100 else ""
    print("::warning::Enrichment fixture coverage gaps (%s) for sportQid Q5369: %s%s" % (label, clean("; ".join(shown)), extra))
open(sys.argv[2], "w").write("\n".join(lines) + "\n")
PY
{
  echo "### Enrichment fixture coverage, ${COVERAGE_LABEL} (NEO-289)"
  cat "$md"
  echo '<details><summary>Raw report</summary>'
  echo
  echo '```json'
  cat "$out"
  echo '```'
  echo '</details>'
} >> "$GITHUB_STEP_SUMMARY"
exit 0
