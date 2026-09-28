// Regression coverage for NEO-309: cleanup-cloudrun-revisions.sh used to hand
// the full `gcloud run services describe` / `revisions list` JSON to python3
// through environment variables. On Linux that JSON can exceed
// MAX_ARG_STRLEN (~128 KiB per env string) — measured in dev at 407KB
// (neonbinder-preprocess) and 143KB (browser) — and execve() fails with
// E2BIG, which bash reports as exit 126 with no useful message.
//
// The fix (this PR) writes that JSON to files in the script's own temp work
// dir and hands python3 only the file paths. These tests prove:
//   1. the pre-fix script really does fail this way on a realistic >128KiB
//      fixture — using a `python3` stub that enforces Linux's limit, since
//      macOS does not;
//   2. the fixed script (working tree) parses the same fixture correctly and
//      produces the same dry-run report a small input gets — i.e. no
//      behavior change beyond surviving the size;
//   3. the error message on a real (non-size) python3 failure names the
//      actual exit code, not a hardcoded lie.
//
// The pre-fix script is a committed, frozen copy under
// scripts/test/fixtures/pre-neo-309/ (see that directory's README) rather
// than a `git show HEAD:...` lookup: CI checkouts are shallow, and a lookup
// keyed on HEAD silently starts asserting the wrong thing the moment this
// fix's own commit becomes HEAD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { buildFixtures } from "./test/fixtures.mjs";
import { makeStubEnv } from "./test/stubs.mjs";
import { REPO_ROOT, runScript, preNeo309Fixture } from "./test/run-script.mjs";

const PRE_FIX_SCRIPT = preNeo309Fixture("cleanup-cloudrun-revisions.sh");

const FIXED_SCRIPT = join(REPO_ROOT, "scripts", "cleanup-cloudrun-revisions.sh");
const PROJECT = "test-project";
const SERVICE = "test-service";

function dryRunArgs() {
  return ["--project", PROJECT, "--service", SERVICE, "--region", "us-central1", "--keep", "5"];
}

test("small input: fixed script keeps serving + most recent, deletes the rest", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 8, servingIndex: 0 });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  const result = runScript(FIXED_SCRIPT, dryRunArgs(), env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /revisions to delete : 3\b/);
  assert.match(result.stdout, /DRY RUN — nothing changed\./);
  assert.match(result.stdout, new RegExp(`${fx.servingName}\\s+min=0\\s+SERVING TRAFFIC`));
});

test("small input: pre-fix script produces the identical dry-run report", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 8, servingIndex: 0 });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  const fixed = runScript(FIXED_SCRIPT, dryRunArgs(), env);
  const before = runScript(PRE_FIX_SCRIPT, dryRunArgs(), env);

  // Below the size that trips the bug, the fix must not change behavior at all.
  assert.equal(before.status, 0, before.stderr || before.stdout);
  assert.equal(before.stdout, fixed.stdout);
});

test(">128KiB input: fixed script still parses correctly and keeps serving/newest", () => {
  const fx = buildFixtures({
    project: PROJECT,
    service: SERVICE,
    count: 80,
    servingIndex: 0,
    tagged: { 30: "pr-99" },
    minScale: { 30: 1 },
  });
  const revJsonSize = Buffer.byteLength(JSON.stringify(fx.revisions));
  assert.ok(
    revJsonSize > 131072,
    `fixture is only ${revJsonSize} bytes — must exceed Linux's 128KiB MAX_ARG_STRLEN to exercise the bug`,
  );

  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });
  const result = runScript(FIXED_SCRIPT, dryRunArgs(), env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /revisions to delete : 75\b/);
  assert.match(result.stdout, /tags to remove {6}: 1\b/);
  assert.match(result.stdout, /warm instances freed: 1\b/);
  assert.match(result.stdout, new RegExp(`${fx.servingName}\\s+min=0\\s+SERVING TRAFFIC`));
  for (let i = 1; i < 5; i++) {
    assert.match(result.stdout, new RegExp(`${fx.nameAt(i)}\\s+min=0\\s+among 5 most recent`));
  }
  assert.match(result.stdout, new RegExp(`${fx.nameAt(30)}\\s+1/512Mi\\s+tags=pr-99`));
  assert.match(result.stdout, /DRY RUN — nothing changed\./);
});

test(">128KiB input: pre-fix script fails with the E2BIG-shaped error", () => {
  const fx = buildFixtures({
    project: PROJECT,
    service: SERVICE,
    count: 80,
    servingIndex: 0,
    tagged: { 30: "pr-99" },
    minScale: { 30: 1 },
  });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  const result = runScript(PRE_FIX_SCRIPT, dryRunArgs(), env);

  // set -euo pipefail with no handler around the python3 call: the script
  // aborts and surfaces the failing command's own exit status verbatim.
  assert.equal(result.status, 126, `expected E2BIG-style exit 126, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /Argument list too long/);
});

test("malformed revision JSON: fixed script's error message carries python3's real exit code", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 3, servingIndex: 0 });
  const { env, revFile } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  // Corrupt the file python3 reads so it raises a real, non-126 exception
  // (json.JSONDecodeError -> python3 exits 1) rather than tripping the
  // MAX_ARG_STRLEN stub. This is the case N1 flagged: inside `if !
  // python3...; then`, `$?` in the then-branch is the `if` construct's own
  // negated boolean (always 0), not python3's actual exit code, so the old
  // message ("python3 exited $?") always claimed exit 0 no matter what
  // really failed.
  writeFileSync(revFile, "{not valid json");

  const result = runScript(FIXED_SCRIPT, dryRunArgs(), env);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /failed to compute the revision GC plan \(python3 exited 1\):/);
  assert.doesNotMatch(result.stderr, /python3 exited 0/);
});
