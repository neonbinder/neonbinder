#!/bin/bash
# ─── gen-flow-timings.sh ──────────────────────────────────────────────────────
# Regenerate .maestro/flow-timings.tsv from a run's Maestro JUnit output.
#
#   ./gen-flow-timings.sh <junit-dir> [current-tsv]   # writes the TSV to STDOUT
#
# <junit-dir>   a directory tree containing the per-flow JUnit *.xml (in CI this is
#               the report job's `all-shards/`; locally it's `maestro-report/junit`).
# [current-tsv] the committed .maestro/flow-timings.tsv — used as the fallback for
#               any flow that didn't get a fresh SUCCESS time this run (so a flaky /
#               failed / not-run flow keeps its last-known value instead of dropping
#               or recording a timeout). Optional.
#
# The authoritative flow list is the ENQUEUE SET (every *.yaml under .maestro/flows
# minus util/wip/setup — the exact selection run-e2e-queue.sh enqueues). We iterate
# that, so: measured-but-not-queued flows (worker-bootstrap, setup*) are naturally
# excluded, deleted flows fall out, and a brand-new flow with a fresh time folds in.
# A flow with neither a fresh time nor a committed value is OMITTED — the consumer
# assigns it the median of the known values (mid-queue) at enqueue time.
#
# Output: a fixed header comment + `<seconds><TAB><path>` rows, canonically sorted
# (seconds desc, path asc). The header is byte-stable so the weekly refresher's
# drift diff only fires on real timing/set changes. DO NOT hand-edit the committed
# file — every "E2E Tests" run rebuilds it (report job → `flow-timings` artifact).
set -euo pipefail

JUNIT_DIR="${1:?usage: gen-flow-timings.sh <junit-dir> [current-tsv]}"
CURRENT_TSV="${2:-}"

# flow_has_tag <file> <tag> → exit 0 if the flow's `tags:` block contains <tag>.
# Duplicated verbatim from run-e2e-queue.sh (keep in sync) so the producer's flow
# set is identical to what enqueue consumes.
flow_has_tag() {
  awk -v want="$2" '
    /^---$/ { exit }
    /^tags:/ { intags=1; next }
    intags && /^[[:space:]]+-[[:space:]]+/ { t=$0; sub(/^[[:space:]]+-[[:space:]]+/,"",t); sub(/[[:space:]]+$/,"",t); if (t==want) {found=1; exit} ; next }
    intags && !/^[[:space:]]/ { intags=0 }
    END { exit(found?0:1) }
  ' "$1"
}

# 1. Enqueue set (authoritative flow list) → temp file.
tc=""  # declared before the trap so `set -u` can't trip if we exit early.
enq="$(mktemp)"; trap 'rm -f "$enq" "${tc:-}"' EXIT
while IFS= read -r f; do
  flow_has_tag "$f" util  && continue
  flow_has_tag "$f" wip   && continue
  flow_has_tag "$f" setup && continue
  printf '%s\n' "$f"
done < <(find .maestro/flows/ -name "*.yaml" | sort) > "$enq"

# 2. Raw <testcase …> tags from every JUnit file → temp file. Guard the empty case
#    (no *.xml at all, e.g. a run where all shards died before reporting) so xargs
#    never blocks on stdin; portable (no GNU `xargs -r`).
tc="$(mktemp)"
# Prefer the canonical per-flow JUnit path (so a tree like CI's `all-shards/` can't
# pull in stray XML); fall back to any *.xml when pointed straight at a junit dir.
junit_files="$(find "$JUNIT_DIR" -path '*/junit/*.xml' 2>/dev/null || true)"
[ -z "$junit_files" ] && junit_files="$(find "$JUNIT_DIR" -name '*.xml' 2>/dev/null || true)"
if [ -n "$junit_files" ]; then
  printf '%s\n' "$junit_files" | tr '\n' '\0' \
    | xargs -0 grep -hoE '<testcase [^>]*>' 2>/dev/null > "$tc" || true
fi

# 3. Merge measured-SUCCESS times with the committed fallback over the enqueue set,
#    emit canonically-sorted rows. (Python: robust attribute parse, order-agnostic.)
{
  cat <<'HDR'
# E2E flow timings — wall-seconds per flow, regenerated from Maestro JUnit by
# gen-flow-timings.sh. Consumed by run-e2e-queue.sh to seed the work-queue
# LONGEST-FIRST (LPT): the Convex queue hands flows out in INSERTION order
# (convex/e2eQueue.ts claimNext → .first() on by_run_status), so seeding the
# biggest flows first lets the work-stealing runner pool start the long poles
# immediately and balances the tail (NEO-61). Alphabetical seeding left a ~4.5 min
# fastest↔slowest runner spread (e2e-sample-run2, 2026-06-20).
#
# Format: <seconds><TAB><repo-relative flow path>, sorted seconds-desc / path-asc.
# Blank lines and lines starting with # are ignored. A flow NOT listed gets the
# median of the known values (mid-queue) at enqueue time, so a new/unmeasured flow
# is never starved to the end; if this file is missing/empty, enqueue falls back to
# alphabetical order.
#
# DO NOT hand-edit: every "E2E Tests" run rebuilds this (report job → `flow-timings`
# artifact) and the weekly refresh-flow-timings.yml opens a chore PR when it drifts.
HDR
  python3 - "$enq" "$tc" "$CURRENT_TSV" <<'PY'
import sys, re, os

enq_path, tc_path, cur_path = sys.argv[1], sys.argv[2], sys.argv[3]

# measured SUCCESS times: path -> max(seconds). Pair file= with time= from the SAME
# <testcase>; skip lines without file= (stale runFlow/subflow artifacts) and any
# testcase whose status is present and not SUCCESS (don't record a failure/timeout).
measured = {}
with open(tc_path) as fh:
    for line in fh:
        f = re.search(r'file="([^"]+)"', line)
        t = re.search(r'time="([0-9.]+)"', line)
        s = re.search(r'status="([^"]+)"', line)
        if not f or not t:
            continue
        if s and s.group(1).upper() != "SUCCESS":
            continue
        p = f.group(1)
        secs = round(float(t.group(1)))
        if p not in measured or secs > measured[p]:
            measured[p] = secs

# committed fallback: path -> seconds (skip comments/blanks).
committed = {}
if cur_path and os.path.exists(cur_path):
    with open(cur_path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 2:
                try:
                    committed[parts[1]] = int(round(float(parts[0])))
                except ValueError:
                    pass

# Iterate the enqueue set; prefer this run's measured time, else committed, else
# omit (consumer median-default covers it).
rows = []
with open(enq_path) as fh:
    for line in fh:
        p = line.strip()
        if not p:
            continue
        if p in measured:
            rows.append((measured[p], p))
        elif p in committed:
            rows.append((committed[p], p))
        # else: no data → omitted on purpose

rows.sort(key=lambda r: (-r[0], r[1]))  # seconds desc, path asc
for secs, p in rows:
    print(f"{secs}\t{p}")
PY
}
