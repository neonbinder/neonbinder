// NEO-546: branch coverage for ci-mode.sh. Stubs `gh` on PATH; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "ci-mode.sh");

// The stub answers by the endpoint in its arguments and reads its behaviour
// from STUB_* variables, so each test states exactly what the API does.
const STUB = `#!/usr/bin/env bash
case "$*" in
  *rules/branches*)
    [ -n "\${STUB_RULES_FAIL:-}" ] && exit 1
    printf '%s' "\${STUB_RULES:-}" ;;
  *head.sha*)
    [ -n "\${STUB_HEAD_FAIL:-}" ] && exit 1
    printf '%s' "\${STUB_HEAD:-}" ;;
  *labels*)
    [ -n "\${STUB_LABELS_FAIL:-}" ] && exit 1
    printf '%s' "\${STUB_LABELS:-}" ;;
  *) exit 1 ;;
esac
`;

function run(env) {
  const dir = mkdtempSync(join(tmpdir(), "nb-ci-mode-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, STUB);
  chmodSync(gh, 0o755);
  const result = spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_SHA: "c".repeat(40),
      GITHUB_REF_NAME: "some-branch",
      ...env,
    },
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  const out = {};
  for (const line of (result.stdout ?? "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return { status: result.status, out, stderr: result.stderr ?? "" };
}

const RULES_WITH_QUEUE = JSON.stringify([{ type: "pull_request" }, { type: "merge_queue" }]);
const RULES_NO_QUEUE = JSON.stringify([{ type: "pull_request" }, { type: "deletion" }]);

const pr = (extra = {}) => ({
  EVENT_NAME: "pull_request",
  PR_NUMBER: "42",
  PR_HEAD_SHA: "a".repeat(40),
  PR_HEAD_REF: "neo-1-thing",
  MERGE_QUEUE: "true",
  STUB_RULES: RULES_WITH_QUEUE,
  STUB_LABELS: "",
  ...extra,
});

test("pull_request: queue live, rule present, no label -> cheap", () => {
  const r = run(pr());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.full, "false");
  assert.equal(r.out.pr, "42");
  assert.equal(r.out.sha, "a".repeat(40));
  assert.equal(r.out.head_sha, "a".repeat(40));
  assert.equal(r.out.head_ref, "neo-1-thing");
});

test("pull_request: other labels do not force full", () => {
  const r = run(pr({ STUB_LABELS: "bug\nneeds-review" }));
  assert.equal(r.out.full, "false");
});

test("pull_request: MERGE_QUEUE unset -> full, today's flow", () => {
  const r = run(pr({ MERGE_QUEUE: "" }));
  assert.equal(r.status, 0);
  assert.equal(r.out.full, "true");
  assert.equal(r.out.pr, "42");
  assert.equal(r.out.head_ref, "neo-1-thing");
});

test("pull_request: MERGE_QUEUE is exactly 'true' (TRUE, 1, yes are not)", () => {
  for (const v of ["TRUE", "1", "yes", "false", " true"]) {
    assert.equal(run(pr({ MERGE_QUEUE: v })).out.full, "true", v);
  }
});

test("pull_request: variable set but no merge_queue rule -> full", () => {
  const r = run(pr({ STUB_RULES: RULES_NO_QUEUE }));
  assert.equal(r.out.full, "true");
  assert.match(r.out.reason, /no merge_queue rule/);
});

test("pull_request: empty rule list -> full", () => {
  assert.equal(run(pr({ STUB_RULES: "[]" })).out.full, "true");
});

test("pull_request: rules API error -> full (fail closed)", () => {
  const r = run(pr({ STUB_RULES_FAIL: "1" }));
  assert.equal(r.status, 0);
  assert.equal(r.out.full, "true");
});

test("pull_request: rules API returns an empty body -> full", () => {
  assert.equal(run(pr({ STUB_RULES: "" })).out.full, "true");
});

test("pull_request: rules API returns garbage -> full", () => {
  assert.equal(run(pr({ STUB_RULES: "<html>nope" })).out.full, "true");
});

test("pull_request: rules API returns a non-array (error object) -> full", () => {
  assert.equal(run(pr({ STUB_RULES: JSON.stringify({ message: "Not Found" }) })).out.full, "true");
});

test("pull_request: run-e2e label forces full", () => {
  const r = run(pr({ STUB_LABELS: "bug\nrun-e2e" }));
  assert.equal(r.out.full, "true");
  assert.match(r.out.reason, /run-e2e/);
});

test("pull_request: a label that merely contains run-e2e does not match", () => {
  assert.equal(run(pr({ STUB_LABELS: "run-e2e-later" })).out.full, "false");
});

test("pull_request: label API error -> full (fail closed)", () => {
  assert.equal(run(pr({ STUB_LABELS_FAIL: "1" })).out.full, "true");
});

test("pull_request: no PR number -> full, no pr", () => {
  const r = run(pr({ PR_NUMBER: "" }));
  assert.equal(r.out.full, "true");
  assert.equal(r.out.pr, "");
});

test("merge_group: always full; PR from the queue ref, head from the API", () => {
  const r = run({
    EVENT_NAME: "merge_group",
    GITHUB_REF: `refs/heads/gh-readonly-queue/main/pr-77-${"b".repeat(40)}`,
    GITHUB_SHA: "d".repeat(40),
    MERGE_QUEUE: "",
    STUB_HEAD: `${"e".repeat(40)}\tneo-77-feature/with-slash`,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.full, "true");
  assert.equal(r.out.pr, "77");
  assert.equal(r.out.sha, "d".repeat(40));
  assert.equal(r.out.head_sha, "e".repeat(40));
  assert.equal(r.out.head_ref, "neo-77-feature/with-slash");
});

test("merge_group: ref without the refs/heads/ prefix parses too", () => {
  const r = run({
    EVENT_NAME: "merge_group",
    GITHUB_REF: `gh-readonly-queue/main/pr-5-${"b".repeat(40)}`,
    STUB_HEAD: `${"e".repeat(40)}\tx`,
  });
  assert.equal(r.out.pr, "5");
});

test("merge_group: unparseable queue ref fails loudly", () => {
  const r = run({ EVENT_NAME: "merge_group", GITHUB_REF: "refs/heads/main", STUB_HEAD: "x\ty" });
  assert.equal(r.status, 1);
  assert.equal(r.out.full, undefined);
});

test("merge_group: PR lookup error fails loudly, never cheap", () => {
  const r = run({
    EVENT_NAME: "merge_group",
    GITHUB_REF: `refs/heads/gh-readonly-queue/main/pr-9-${"b".repeat(40)}`,
    STUB_HEAD_FAIL: "1",
  });
  assert.equal(r.status, 1);
  assert.notEqual(r.out.full, "false");
});

test("merge_group: PR lookup returns nothing usable -> fails loudly", () => {
  for (const head of ["", "onlyonefield", `${"e".repeat(40)}\t`]) {
    const r = run({
      EVENT_NAME: "merge_group",
      GITHUB_REF: `refs/heads/gh-readonly-queue/main/pr-9-${"b".repeat(40)}`,
      STUB_HEAD: head,
    });
    assert.equal(r.status, 1, JSON.stringify(head));
  }
});

test("merge_group ignores MERGE_QUEUE, rules and labels", () => {
  const r = run({
    EVENT_NAME: "merge_group",
    GITHUB_REF: `refs/heads/gh-readonly-queue/main/pr-3-${"b".repeat(40)}`,
    MERGE_QUEUE: "true",
    STUB_RULES_FAIL: "1",
    STUB_LABELS_FAIL: "1",
    STUB_HEAD: `${"e".repeat(40)}\tbranch`,
  });
  assert.equal(r.out.full, "true");
});

test("workflow_dispatch: full, no PR", () => {
  const r = run({ EVENT_NAME: "workflow_dispatch", MERGE_QUEUE: "true", STUB_RULES: RULES_WITH_QUEUE });
  assert.equal(r.status, 0);
  assert.equal(r.out.full, "true");
  assert.equal(r.out.pr, "");
  assert.equal(r.out.sha, "c".repeat(40));
  assert.equal(r.out.head_ref, "some-branch");
});

test("push and an unknown event: full", () => {
  assert.equal(run({ EVENT_NAME: "push" }).out.full, "true");
  assert.equal(run({}).out.full, "true");
});
