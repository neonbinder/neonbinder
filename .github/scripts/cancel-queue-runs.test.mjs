// NEO-546 S5: cancel-queue-runs.sh with a stubbed `gh`. Cancelled run ids are
// appended to a file by the stub so the test can see exactly what was cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "cancel-queue-runs.sh");

const MINE = "2026-11-13T20:00:00Z";
const q = (pr, sha = "a".repeat(40)) => `gh-readonly-queue/main/pr-${pr}-${sha}`;

function run({ mine = MINE, runs = {}, listFail = false, cancelFail = false, pr = "42", runId = "999" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nb-cq-"));
  const log = join(dir, "cancelled.txt");
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
case "$*" in
  "run cancel"*) [ -n "$STUB_CANCEL_FAIL" ] && exit 1; echo "$3" >> "${log}"; exit 0 ;;
  *"actions/runs/${runId}"*) [ -z "$STUB_MINE" ] && exit 1; printf '%s' "$STUB_MINE"; exit 0 ;;
  *"status=queued"*) [ -n "$STUB_LIST_FAIL" ] && exit 1; printf '%s' "$STUB_QUEUED"; exit 0 ;;
  *"status=in_progress"*) printf '%s' "$STUB_PROGRESS"; exit 0 ;;
esac
exit 1
`,
  );
  chmodSync(gh, 0o755);
  const wrap = (list) => JSON.stringify({ workflow_runs: list ?? [] });
  const r = spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_RUN_ID: runId,
      PR: pr,
      STUB_MINE: mine,
      STUB_QUEUED: wrap(runs.queued),
      STUB_PROGRESS: wrap(runs.in_progress),
      STUB_LIST_FAIL: listFail ? "1" : "",
      STUB_CANCEL_FAIL: cancelFail ? "1" : "",
    },
    encoding: "utf8",
  });
  const cancelled = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: r.status, out: r.stdout.trim(), stderr: r.stderr, cancelled };
}

test("cancels this PR's older queue runs, queued and in progress", () => {
  const r = run({
    runs: {
      queued: [{ id: 1, head_branch: q(42), created_at: "2026-11-13T19:00:00Z" }],
      in_progress: [{ id: 2, head_branch: q(42), created_at: "2026-11-13T19:30:00Z" }],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.cancelled.sort(), ["1", "2"]);
  assert.equal(r.out, "cancelled=1 2");
});

test("leaves a run created after this run (the re-enqueued group) alone", () => {
  const r = run({
    runs: { in_progress: [
      { id: 5, head_branch: q(42), created_at: "2026-11-13T20:00:01Z" },
      { id: 6, head_branch: q(42), created_at: "2026-11-13T19:59:59Z" },
    ] },
  });
  assert.deepEqual(r.cancelled, ["6"]);
});

test("a run created in the same second is not older, so it is left alone", () => {
  const r = run({ runs: { in_progress: [{ id: 7, head_branch: q(42), created_at: MINE }] } });
  assert.deepEqual(r.cancelled, []);
});

test("other PRs' runs and PR 4 vs 42 are not matched", () => {
  const r = run({
    pr: "4",
    runs: { in_progress: [
      { id: 8, head_branch: q(42), created_at: "2026-11-13T19:00:00Z" },
      { id: 9, head_branch: q(4), created_at: "2026-11-13T19:00:00Z" },
      { id: 10, head_branch: "main", created_at: "2026-11-13T19:00:00Z" },
      { id: 11, head_branch: `x/${q(4)}`, created_at: "2026-11-13T19:00:00Z" },
    ] },
  });
  assert.deepEqual(r.cancelled, ["9"]);
});

test("cannot read this run's created_at -> cancels nothing, exit 1", () => {
  const r = run({ mine: "", runs: { queued: [{ id: 1, head_branch: q(42), created_at: "2026-11-13T19:00:00Z" }] } });
  assert.equal(r.status, 1);
  assert.deepEqual(r.cancelled, []);
});

test("list failure cancels nothing and does not fail", () => {
  const r = run({ listFail: true, runs: { in_progress: [{ id: 3, head_branch: q(42), created_at: "2026-11-13T19:00:00Z" }] } });
  // queued listing failed; in_progress still works and its older run goes
  assert.equal(r.status, 0);
  assert.deepEqual(r.cancelled, ["3"]);
});

test("a failing cancel is a warning, not a failure", () => {
  const r = run({ cancelFail: true, runs: { queued: [{ id: 1, head_branch: q(42), created_at: "2026-11-13T19:00:00Z" }] } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /could not cancel/);
});

test("bad inputs exit 1 and cancel nothing", () => {
  assert.equal(run({ pr: "" }).status, 1);
  assert.equal(run({ pr: "4 2" }).status, 1);
  assert.equal(run({ runId: "abc" }).status, 1);
});
