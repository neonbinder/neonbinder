#!/usr/bin/env bash
# Tests for `watch.sh --queue` against a fake gh. Run: bash test/queue.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PR_WATCH_GH="$HERE/fake-gh.sh" PR_WATCH_INTERVAL=0 PR_WATCH_REPO=acme/widgets
fails=0

pr() { # state mqEntryJson nodesJson
  printf '{"data":{"repository":{"pullRequest":{"state":"%s","mergeCommit":{"oid":"abc123"},"mergeQueueEntry":%s,"timelineItems":{"nodes":%s}}}}}' "$1" "$2" "$3"
}
ADD='{"__typename":"AddedToMergeQueueEvent","createdAt":"2026-11-14T10:00:00Z"}'
rem() { printf '{"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-11-14T10:30:00Z","reason":"%s","actor":%s}' "$1" "$2"; }
RUN='[{"databaseId":7,"headBranch":"gh-readonly-queue/main/pr-42-deadbeef","status":"%s","conclusion":"%s","url":"https://example.invalid/runs/7","workflowName":"PR Pipeline","createdAt":"2026-11-14T10:01:00Z"},{"databaseId":8,"headBranch":"gh-readonly-queue/main/pr-421-cafe","status":"completed","conclusion":"failure","url":"https://example.invalid/runs/8","workflowName":"Other PR","createdAt":"2026-11-14T10:01:00Z"}]'
JOBS='{"jobs":[{"name":"CI Gate","status":"%s","conclusion":"%s","url":"https://example.invalid/jobs/1"},{"name":"E2E / shard-desktop (3, 8)","status":"completed","conclusion":"failure","url":"https://example.invalid/jobs/2"}]}'

run() { # name expectExit expectPattern  (fixtures already in $FIX); extra args after
  local name="$1" code="$2" pat="$3" out rc
  out=$(bash "$HERE/../watch.sh" --queue 42 2>&1); rc=$?
  if [ "$rc" = "$code" ] && echo "$out" | grep -Eq -- "$pat"; then echo "ok   $name"
  else echo "FAIL $name (exit $rc, wanted $code /$pat/)"; echo "$out" | sed 's/^/     /'; fails=$((fails+1)); fi
}
fresh() { FIX=$(mktemp -d); export FIX; echo '[]' > "$FIX/runs.json"; }

fresh; pr MERGED null "[$ADD]" > "$FIX/graphql.json"
run "merged" 0 '^DONE MERGED .*abc123'

fresh; pr OPEN null "[$ADD,$(rem CI_FAILURE '{"__typename":"Bot","login":"github-actions[bot]"}')]" > "$FIX/graphql.json"
printf "$RUN" completed failure > "$FIX/runs.json"; printf "$JOBS" completed failure > "$FIX/run-7.json"
run "ejected names reason and failing job, ignores another PR's run" 1 'DONE EJECTED.*CI_FAILURE.*PR Pipeline / E2E / shard-desktop \(3, 8\): https://example.invalid/jobs/2'

fresh; pr OPEN null "[$ADD,$(rem CI_TIMEOUT null)]" > "$FIX/graphql.json"
run "ejected on timeout with no failing job" 1 'DONE EJECTED.*CI_TIMEOUT.*no failing job'

fresh; pr OPEN null "[$ADD,$(rem MANUAL '{"__typename":"User","login":"someone"}')]" > "$FIX/graphql.json"
run "removed by hand" 4 'DONE REMOVED.*someone.*do not re-enqueue'

fresh; pr OPEN null "[$ADD,$(rem SOMETHING_NEW null)]" > "$FIX/graphql.json"
run "unknown reason is REMOVED, not EJECTED" 4 'DONE REMOVED.*SOMETHING_NEW'

fresh; pr OPEN null "[$ADD,$(rem CI_FAILURE '{"__typename":"User","login":"someone"}')]" > "$FIX/graphql.json"
run "known reason with a human actor is REMOVED" 4 'DONE REMOVED.*CI_FAILURE.*someone'

fresh; pr OPEN null "[]" > "$FIX/graphql.json"
PR_WATCH_REPO=other/repo run "wrong repo refused" 3 'DONE ERROR.*only watches other/repo'

fresh; pr CLOSED null "[$ADD]" > "$FIX/graphql.json"
run "closed without merge" 4 'DONE REMOVED.*closed'

# An older ejection must not hide a fresh enqueue: it is in the queue again,
# then merges on the second poll. Never reports green or ejected on the way.
fresh; Q='{"state":"AWAITING_CHECKS","position":1}'
OLD=$(rem CI_FAILURE null | sed 's/10:30/09:30/')
pr OPEN "$Q" "[$OLD,$ADD]" > "$FIX/graphql.json.1"; pr MERGED null "[$OLD,$ADD]" > "$FIX/graphql.json.2"
printf "$RUN" in_progress "" > "$FIX/runs.json"; printf "$JOBS" in_progress "" > "$FIX/run-7.json"
out=$(bash "$HERE/../watch.sh" --queue 42 2>&1); rc=$?
if [ "$rc" = 0 ] && echo "$out" | grep -q 'RUNNING — AWAITING_CHECKS' && echo "$out" | grep -q 'DONE MERGED' && ! echo "$out" | grep -q 'GREEN'; then echo "ok   re-enqueue then merge"
else echo "FAIL re-enqueue then merge ($rc)"; echo "$out" | sed 's/^/     /'; fails=$((fails+1)); fi

fresh; pr OPEN null "[]" > "$FIX/graphql.json"
PR_WATCH_ENQUEUE_GRACE_MIN=0 run "never enqueued" 5 'DONE NOT_QUEUED'

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
