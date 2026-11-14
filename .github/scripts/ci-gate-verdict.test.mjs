// NEO-546: branch coverage for ci-gate-verdict.sh. Pure env in, exit status out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "ci-gate-verdict.sh");

const GREEN = {
  EVENT_NAME: "pull_request",
  FULL: "true",
  R_CHANGES: "success",
  R_WEB_LINT: "success",
  R_WEB_TYPECHECK: "success",
  R_WEB_UNIT: "success",
  R_BROWSER_TEST: "skipped",
  R_PREPROCESS_TEST: "skipped",
  R_SCRIPTS_TEST: "skipped",
  R_SCANNER_TEST: "skipped",
  R_SCANNER_BUILD: "skipped",
  R_CROP_MATRIX: "skipped",
  R_MASK_PARITY: "skipped",
  R_PREPROCESS_CHANGED: "false",
  R_WIRE: "skipped",
  R_WIRE_PREPROCESS: "skipped",
  R_WIRE_CAPACITY: "skipped",
  R_WEB_PREVIEW: "success",
  R_E2E: "success",
  R_DEPS_ONLY: "false",
  R_HYGIENE: "success",
  R_CAPACITY_PARITY: "success",
};

const CHEAP = {
  ...GREEN,
  FULL: "false",
  R_WEB_PREVIEW: "skipped",
  R_E2E: "skipped",
};

function run(over) {
  const r = spawnSync("bash", [SCRIPT], {
    env: { PATH: process.env.PATH, ...GREEN, ...over },
    encoding: "utf8",
  });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// --- full mode: exactly today's verdict -------------------------------------

test("full: all green passes", () => {
  const r = run({});
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /CI Gate: PASS —/);
});

test("full: a skipped e2e fails", () => {
  assert.equal(run({ R_E2E: "skipped" }).status, 1);
});

test("full: a skipped web-preview with a green e2e is still green-listed (e2e rule decides)", () => {
  assert.equal(run({ R_WEB_PREVIEW: "skipped" }).status, 0);
});

test("full: deps_only allows a skipped e2e", () => {
  const r = run({ R_E2E: "skipped", R_DEPS_ONLY: "true", R_WEB_PREVIEW: "skipped" });
  assert.equal(r.status, 0, r.out);
});

test("full: deps_only does not excuse a failed e2e", () => {
  assert.equal(run({ R_E2E: "failure", R_DEPS_ONLY: "true" }).status, 1);
});

test("full: cancelled e2e fails", () => {
  assert.equal(run({ R_E2E: "cancelled" }).status, 1);
});

test("full: changes must succeed", () => {
  assert.equal(run({ R_CHANGES: "skipped" }).status, 1);
  assert.equal(run({ R_CHANGES: "failure" }).status, 1);
});

test("full: hygiene and capacity-parity may not be skipped", () => {
  assert.equal(run({ R_HYGIENE: "skipped" }).status, 1);
  assert.equal(run({ R_CAPACITY_PARITY: "skipped" }).status, 1);
});

test("full: preprocess changed requires mask parity to succeed", () => {
  assert.equal(run({ R_PREPROCESS_CHANGED: "true", R_MASK_PARITY: "skipped" }).status, 1);
  assert.equal(run({ R_PREPROCESS_CHANGED: "true", R_MASK_PARITY: "success" }).status, 0);
});

test("full: preprocess unchanged tolerates skip, rejects failure", () => {
  assert.equal(run({ R_MASK_PARITY: "skipped" }).status, 0);
  assert.equal(run({ R_MASK_PARITY: "failure" }).status, 1);
});

test("full: any area or wiring job failing fails the gate", () => {
  for (const k of [
    "R_WEB_LINT", "R_WEB_TYPECHECK", "R_WEB_UNIT", "R_BROWSER_TEST", "R_PREPROCESS_TEST",
    "R_SCRIPTS_TEST", "R_SCANNER_TEST", "R_SCANNER_BUILD", "R_CROP_MATRIX", "R_WIRE",
    "R_WIRE_PREPROCESS", "R_WIRE_CAPACITY", "R_WEB_PREVIEW",
  ]) {
    assert.equal(run({ [k]: "failure" }).status, 1, k);
    assert.equal(run({ [k]: "cancelled" }).status, 1, k);
  }
});

test("full: an empty result (missing needs) fails", () => {
  assert.equal(run({ R_WEB_LINT: "" }).status, 1);
});

// --- cheap mode -------------------------------------------------------------

test("cheap: skipped preview and e2e pass, and say it is not a merge verdict", () => {
  const r = run(CHEAP);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS \(cheap\)/);
  assert.match(r.out, /NOT a merge verdict/);
});

test("cheap: every heavy job may be skipped", () => {
  const r = run({
    ...CHEAP,
    R_CROP_MATRIX: "skipped", R_MASK_PARITY: "skipped", R_WIRE: "skipped",
    R_WIRE_PREPROCESS: "skipped", R_WIRE_CAPACITY: "skipped",
    R_PREPROCESS_CHANGED: "true",
  });
  assert.equal(r.status, 0, r.out);
});

test("cheap: a cheap job still has to pass", () => {
  for (const k of ["R_WEB_LINT", "R_WEB_TYPECHECK", "R_WEB_UNIT", "R_BROWSER_TEST", "R_SCRIPTS_TEST"]) {
    assert.equal(run({ ...CHEAP, [k]: "failure" }).status, 1, k);
  }
});

test("cheap: hygiene, capacity-parity and changes are never skippable", () => {
  assert.equal(run({ ...CHEAP, R_HYGIENE: "skipped" }).status, 1);
  assert.equal(run({ ...CHEAP, R_CAPACITY_PARITY: "skipped" }).status, 1);
  assert.equal(run({ ...CHEAP, R_CHANGES: "skipped" }).status, 1);
});

test("cheap: a heavy job that ran and failed still fails", () => {
  assert.equal(run({ ...CHEAP, R_E2E: "failure" }).status, 1);
  assert.equal(run({ ...CHEAP, R_E2E: "cancelled" }).status, 1);
  assert.equal(run({ ...CHEAP, R_MASK_PARITY: "failure" }).status, 1);
  assert.equal(run({ ...CHEAP, R_WEB_PREVIEW: "failure" }).status, 1);
  assert.equal(run({ ...CHEAP, R_WIRE: "failure" }).status, 1);
});

test("cheap: a heavy job that ran and passed is fine", () => {
  assert.equal(run({ ...CHEAP, R_E2E: "success", R_WEB_PREVIEW: "success" }).status, 0);
});

// --- cheap is only ever pull_request + FULL=false ---------------------------

test("a skipped e2e fails when FULL is true, empty or garbage", () => {
  for (const full of ["true", "", "maybe", "FALSE", "False"]) {
    assert.equal(run({ ...CHEAP, FULL: full }).status, 1, JSON.stringify(full));
  }
});

test("a skipped e2e fails on every non-pull_request event, even with FULL=false", () => {
  for (const ev of ["merge_group", "push", "workflow_dispatch", ""]) {
    assert.equal(run({ ...CHEAP, EVENT_NAME: ev }).status, 1, JSON.stringify(ev));
  }
});

test("merge_group: no skip is accepted", () => {
  const mg = { ...GREEN, EVENT_NAME: "merge_group", FULL: "true" };
  assert.equal(run(mg).status, 0);
  assert.equal(run({ ...mg, R_E2E: "skipped" }).status, 1);
  assert.equal(run({ ...mg, R_PREPROCESS_CHANGED: "true", R_MASK_PARITY: "skipped" }).status, 1);
});

test("merge_group claiming FULL=false is a fault even when everything is green", () => {
  const r = run({ ...GREEN, EVENT_NAME: "merge_group", FULL: "false", R_E2E: "success" });
  assert.equal(r.status, 1);
  assert.match(r.out, /merge_group run reports full/);
});

test("merge_group: deps_only cannot excuse a skipped e2e unless it says so (it never does)", () => {
  const mg = { ...GREEN, EVENT_NAME: "merge_group", FULL: "true", R_E2E: "skipped", R_DEPS_ONLY: "false" };
  assert.equal(run(mg).status, 1);
});
