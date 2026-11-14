// NEO-546: branch coverage for queue-eject-gate.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "queue-eject-gate.sh");

function run(env) {
  const r = spawnSync("bash", [SCRIPT], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  const out = {};
  for (const line of (r.stdout ?? "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return { status: r.status, out, lines: (r.stdout ?? "").trim().split("\n") };
}

const dq = (reason) => run({ EVENT_ACTION: "dequeued", REASON: reason });

test("closed: teardown, quiet", () => {
  const r = run({ EVENT_ACTION: "closed" });
  assert.equal(r.status, 0);
  assert.equal(r.out.teardown, "true");
  assert.equal(r.out.notify, "false");
});

test("closed ignores any reason", () => {
  const r = run({ EVENT_ACTION: "closed", REASON: "CI_FAILURE" });
  assert.equal(r.out.notify, "false");
});

test("dequeued by a failed check: teardown and notify", () => {
  const r = dq("CI_FAILURE");
  assert.equal(r.out.teardown, "true");
  assert.equal(r.out.notify, "true");
  assert.match(r.out.detail, /check failed/);
});

test("dequeued by a timeout: teardown and notify", () => {
  const r = dq("CI_TIMEOUT");
  assert.equal(r.out.teardown, "true");
  assert.equal(r.out.notify, "true");
  assert.match(r.out.detail, /timed out/);
});

test("dequeued by hand: teardown, quiet", () => {
  const r = dq("MANUAL");
  assert.equal(r.out.teardown, "true");
  assert.equal(r.out.notify, "false");
});

test("dequeued because it merged: nothing (the closed event cleans up)", () => {
  for (const reason of ["SUCCESS", "MERGED", "ALREADY_MERGED"]) {
    const r = dq(reason);
    assert.equal(r.out.teardown, "false", reason);
    assert.equal(r.out.notify, "false", reason);
  }
});

test("reasons are case-insensitive", () => {
  assert.equal(dq("ci_failure").out.notify, "true");
  assert.equal(dq("manual").out.notify, "false");
  assert.equal(dq("Success").out.teardown, "false");
});

test("an unfamiliar reason notifies and tears down", () => {
  for (const reason of ["MERGE_CONFLICT", "BRANCH_PROTECTIONS", "QUEUE_CLEARED", "SOMETHING_NEW"]) {
    const r = dq(reason);
    assert.equal(r.out.teardown, "true", reason);
    assert.equal(r.out.notify, "true", reason);
    assert.match(r.out.detail, new RegExp(reason));
  }
});

test("an empty or missing reason notifies and tears down", () => {
  for (const r of [dq(""), run({ EVENT_ACTION: "dequeued" })]) {
    assert.equal(r.out.teardown, "true");
    assert.equal(r.out.notify, "true");
  }
});

test("any other action does nothing", () => {
  for (const env of [{ EVENT_ACTION: "enqueued" }, { EVENT_ACTION: "" }, {}]) {
    const r = run(env);
    assert.equal(r.status, 0);
    assert.equal(r.out.teardown, "false");
    assert.equal(r.out.notify, "false");
  }
});

test("a hostile reason cannot add output lines or markup", () => {
  const r = dq("CI_FAILURE\nteardown=false\nnotify=false @everyone `x`");
  assert.equal(r.out.notify, "true");
  assert.equal(r.out.teardown, "true");
  assert.equal(r.lines.length, 4);
  assert.match(r.out.reason, /^[A-Z0-9_]+$/);
});

test("a very long reason is capped", () => {
  const r = dq("A".repeat(500));
  assert.ok(r.out.reason.length <= 40);
});

// --- S5: the PR is back in the queue ----------------------------------------

test("S5: dequeued but the PR is queued again -> no teardown, still notifies a failure", () => {
  for (const entry of ["present", "unknown", "garbage"]) {
    const r = run({ EVENT_ACTION: "dequeued", REASON: "CI_FAILURE", QUEUE_ENTRY: entry });
    assert.equal(r.out.teardown, "false", entry);
    assert.equal(r.out.notify, "true", entry);
    assert.match(r.out.detail, /teardown skipped/);
  }
});

test("S5: a manual dequeue with the PR queued again does not tear down", () => {
  const r = run({ EVENT_ACTION: "dequeued", REASON: "MANUAL", QUEUE_ENTRY: "present" });
  assert.equal(r.out.teardown, "false");
  assert.equal(r.out.notify, "false");
});

test("S5: queue entry absent or unset tears down as before", () => {
  assert.equal(run({ EVENT_ACTION: "dequeued", REASON: "CI_FAILURE", QUEUE_ENTRY: "absent" }).out.teardown, "true");
  assert.equal(run({ EVENT_ACTION: "dequeued", REASON: "CI_FAILURE" }).out.teardown, "true");
});

test("S5: a closed PR tears down whatever the queue says", () => {
  assert.equal(run({ EVENT_ACTION: "closed", QUEUE_ENTRY: "present" }).out.teardown, "true");
});
