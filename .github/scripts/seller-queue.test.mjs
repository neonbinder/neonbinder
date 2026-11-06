// Decision-logic coverage for seller-queue.sh (NEO-415). A stub `gh` serves
// canned API bodies from a temp dir, so no network and no GitHub API call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "seller-queue.sh");
const REPO = "o/r";
const SCRIPT_TEXT = readFileSync(SCRIPT, "utf8");
const STEP = /^STEP_NAME='([^']+)'$/m.exec(SCRIPT_TEXT)[1];
const JOB_RE = new RegExp(/^JOB_RE='([^']+)'$/m.exec(SCRIPT_TEXT)[1]);
const ME_RUN = 100;
const NAME = "E2E / Marketplace seller specs (desktop)";
const at = (minAgo) => new Date(Date.now() - minAgo * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
const key = (p) => p.replace(/[/?=&]/g, "_");

const passed = [{ name: STEP, status: "completed", conclusion: "success" }];
const job = (o) => ({
  id: 1, run_id: 200, name: NAME, status: "in_progress", runner_name: "other",
  started_at: at(5), steps: [], ...o,
});
const me = job({ id: 50, run_id: ME_RUN, runner_name: "me", started_at: at(2) });
const jobsBody = (jobs, extra = {}) => ({ total_count: jobs.length, jobs, ...extra });
const runsBody = (runs, extra = {}) => ({ total_count: runs.length, workflow_runs: runs, ...extra });
const ownRun = (id) => ({ id, head_repository: { full_name: REPO } });

// `files` maps an API path to a body; the value "FAIL" makes that call exit 1.
function run(files) {
  const dir = mkdtempSync(join(tmpdir(), "nb-seller-queue-"));
  const base = {
    [`repos/${REPO}/actions/runs/${ME_RUN}/jobs?per_page=100`]: jobsBody([me]),
    [`repos/${REPO}/actions/workflows/pr-pipeline.yml/runs?status=in_progress&per_page=100`]: runsBody([]),
    [`repos/${REPO}/actions/workflows/e2e.yml/runs?status=in_progress&per_page=100`]: runsBody([]),
    [`repos/${REPO}/actions/workflows/pr-pipeline.yml/runs?status=queued&per_page=100`]: runsBody([]),
    [`repos/${REPO}/actions/workflows/e2e.yml/runs?status=queued&per_page=100`]: runsBody([]),
    ...files,
  };
  for (const [p, body] of Object.entries(base)) {
    writeFileSync(join(dir, key(p)), body === "FAIL" ? "FAIL" : JSON.stringify(body));
  }
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
[ "$1" = api ] || exit 2
[ "$2" = rate_limit ] && { echo 99; exit 0; }
f="${dir}/$(printf '%s' "$2" | sed 's#[/?=&]#_#g')"
[ -f "$f" ] || { echo "HTTP 404" >&2; exit 1; }
if [ "$(cat "$f")" = FAIL ]; then echo "gh: HTTP 500 boom" >&2; exit 1; fi
cat "$f"
`,
  );
  chmodSync(gh, 0o755);
  const r = spawnSync("bash", [SCRIPT], {
    env: {
      PATH: process.env.PATH, GH: gh, GH_TOKEN: "x", GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: String(ME_RUN),
      RUNNER_NAME: "me", SELLER_QUEUE_MAX_MIN: "0", SELLER_QUEUE_POLL_S: "1", SELLER_QUEUE_BACKOFF_S: "1",
    },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const PR_RUNS = `repos/${REPO}/actions/workflows/pr-pipeline.yml/runs?status=in_progress&per_page=100`;
const E2E_RUNS = `repos/${REPO}/actions/workflows/e2e.yml/runs?status=in_progress&per_page=100`;
const PR_QUEUED = `repos/${REPO}/actions/workflows/pr-pipeline.yml/runs?status=queued&per_page=100`;
const E2E_QUEUED = `repos/${REPO}/actions/workflows/e2e.yml/runs?status=queued&per_page=100`;
const jobsOf = (id) => `repos/${REPO}/actions/runs/${id}/jobs?per_page=100`;
const go = (r) => assert.ok(r.status === 0 && /our turn/.test(r.out), r.out);
const blocked = (r, re) => assert.ok(r.status === 1 && re.test(r.out), r.out);

test("alone: goes", () => go(run({})));

test("a fork run holding the queue is ignored", () =>
  go(run({
    [PR_RUNS]: runsBody([{ id: 200, head_repository: { full_name: "evil/r" } }]),
    [jobsOf(200)]: jobsBody([job({ steps: passed })]),
  })));

test("a same-repo holder blocks", () =>
  blocked(run({ [PR_RUNS]: runsBody([ownRun(200)]), [jobsOf(200)]: jobsBody([job({ steps: passed })]) }), /1 ahead: run 200 \(running\)/));

test("a held job that started later than us still blocks", () =>
  blocked(run({
    [PR_RUNS]: runsBody([ownRun(200)]),
    [jobsOf(200)]: jobsBody([job({ started_at: at(0), steps: passed })]),
  }), /run 200 \(running\)/));

test("an earlier queued job blocks; a later one does not", () => {
  blocked(run({ [PR_RUNS]: runsBody([ownRun(200)]), [jobsOf(200)]: jobsBody([job({ started_at: at(10) })]) }), /run 200 \(queued\)/);
  go(run({ [PR_RUNS]: runsBody([ownRun(200)]), [jobsOf(200)]: jobsBody([job({ started_at: at(0) })]) }));
});

// NEO-445: GitHub can call a run `queued` while one of its jobs runs (seen on a
// rerun). The job, not the run's word for itself, says who counts.
test("a run reported as queued with its seller job running holds the queue", () =>
  blocked(run({
    [PR_QUEUED]: runsBody([ownRun(200)]),
    [jobsOf(200)]: jobsBody([job({ steps: passed })]),
  }), /1 ahead: run 200 \(running\)/));

test("a run reported as queued with an earlier seller job still waiting its turn blocks", () =>
  blocked(run({
    [E2E_QUEUED]: runsBody([ownRun(200)]),
    [jobsOf(200)]: jobsBody([job({ started_at: at(10) })]),
  }), /run 200 \(queued\)/));

test("a run reported as queued whose seller job has not started blocks no one", () => {
  // Older than us, so it would count by age: this is the deadlock to avoid (a
  // run queued behind its own PR's run, which is itself waiting on this queue).
  go(run({
    [PR_QUEUED]: runsBody([ownRun(200)]),
    [jobsOf(200)]: jobsBody([job({ status: "queued", started_at: at(10) })]),
  }));
  go(run({ [PR_QUEUED]: runsBody([ownRun(200)]), [jobsOf(200)]: jobsBody([]) }));
  go(run({
    [PR_QUEUED]: runsBody([ownRun(200)]),
    [jobsOf(200)]: jobsBody([job({ status: "completed", conclusion: "success", steps: passed })]),
  }));
});

test("a run listed both ways is read once, as in progress", () => {
  const r = run({
    [PR_RUNS]: runsBody([ownRun(200)]),
    [PR_QUEUED]: runsBody([ownRun(200)]),
    [jobsOf(200)]: jobsBody([job({ status: "queued", started_at: at(10) })]),
  });
  blocked(r, /1 ahead: run 200 \(queued\)/);
});

test("a fork's run reported as queued is ignored", () =>
  go(run({
    [PR_QUEUED]: runsBody([{ id: 200, head_repository: { full_name: "evil/r" } }]),
    [jobsOf(200)]: jobsBody([job({ steps: passed })]),
  })));

test("a failing queued-runs call is unreadable, never go", () =>
  blocked(run({ [E2E_QUEUED]: "FAIL" }), /unreadable: could not list e2e\.yml runs/));

test("a queued-runs listing with total_count 101 is unreadable", () =>
  blocked(run({ [PR_QUEUED]: runsBody([], { total_count: 101 }) }), /unreadable: pr-pipeline\.yml run list truncated/));

test("a failing jobs call is unreadable, never go", () =>
  blocked(run({ [PR_RUNS]: runsBody([ownRun(200)]), [jobsOf(200)]: "FAIL" }), /unreadable: could not read the jobs of run 200/));

test("a failing runs call is unreadable", () => blocked(run({ [E2E_RUNS]: "FAIL" }), /unreadable: could not list e2e\.yml runs/));

test("a jobs listing with total_count 101 is unreadable", () =>
  blocked(run({
    [PR_RUNS]: runsBody([ownRun(200)]),
    [jobsOf(200)]: jobsBody([], { total_count: 101 }),
  }), /unreadable: run 200 job list truncated/));

test("a runs listing with total_count 101 is unreadable", () =>
  blocked(run({ [PR_RUNS]: runsBody([], { total_count: 101 }) }), /unreadable: pr-pipeline\.yml run list truncated/));

test("our own job missing from our run's list is unreadable", () =>
  blocked(run({ [jobsOf(ME_RUN)]: jobsBody([]) }), /unreadable: this job is not in its run's job list/));

test("a same-repo run with no head repository (workflow_dispatch) still holds the queue", () => {
  blocked(run({
    [E2E_RUNS]: runsBody([{ id: 200, head_repository: null, repository: { full_name: REPO } }]),
    [jobsOf(200)]: jobsBody([job({ name: "Marketplace seller specs (mobile)", steps: passed })]),
  }), /run 200 \(running\)/);
  go(run({
    [E2E_RUNS]: runsBody([{ id: 200, head_repository: null, repository: { full_name: "evil/r" } }]),
    [jobsOf(200)]: jobsBody([job({ steps: passed })]),
  }));
});

test("a job whose name only resembles a seller job, and injected text, are neither counted nor echoed", () => {
  const r = run({
    [PR_RUNS]: runsBody([ownRun(200)]),
    [jobsOf(200)]: jobsBody([job({ name: "::error::pwn Marketplace seller specs (desktop) x", steps: passed })]),
  });
  go(r);
  assert.ok(!r.out.includes("pwn"), r.out);
});

test("e2e.yml names exactly two queue steps and two seller jobs as the script expects", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github", "workflows", "e2e.yml"), "utf8");
  const lines = yml.split("\n");
  const stepNames = lines.filter((l) => /^\s+- name: /.test(l) && l.replace(/^\s+- name: /, "").trim() === STEP);
  assert.equal(stepNames.length, 2, `expected two steps named '${STEP}'`);
  assert.ok(!yml.includes("SELLER_QUEUE_STEP"), "the step name must be a literal, not an expression");
  const jobNames = lines
    .filter((l) => /^    name: Marketplace seller specs /.test(l))
    .map((l) => `E2E / ${l.replace(/^    name: /, "").trim()}`);
  assert.equal(jobNames.length, 2);
  for (const n of jobNames) assert.match(n, JOB_RE);
  assert.deepEqual(jobNames.map((n) => /\((\w+)\)$/.exec(n)[1]).sort(), ["desktop", "mobile"]);
});

// NEO-445: the accounts are cleared inside the queue's turn, before any spec.
test("in both seller jobs the seller cleanup is the step right after the queue", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github", "workflows", "e2e.yml"), "utf8");
  const names = yml.split("\n").filter((l) => /^      - (name|uses|run): /.test(l)).map((l) => l.trim());
  const queueAt = names.flatMap((n, i) => (n === `- name: ${STEP}` ? [i] : []));
  assert.equal(queueAt.length, 2);
  for (const i of queueAt) {
    assert.equal(names[i + 1], "- name: Clear the seller accounts for the specs");
  }
  assert.equal(yml.match(/testingSellerCleanup:clearSellerAccounts/g)?.length, 2, "exactly the two seller jobs run it");
});
