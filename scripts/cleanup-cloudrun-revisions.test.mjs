// Regression coverage for NEO-309: cleanup-cloudrun-revisions.sh used to hand
// the full `gcloud run services describe` / `revisions list` JSON to python3
// through environment variables. On Linux that JSON can exceed
// MAX_ARG_STRLEN (~128 KiB per env string) — measured in dev at 407KB
// (neonbinder-preprocess) and 143KB (browser) — and execve() fails with
// E2BIG, which bash reports as exit 126 with no useful message.
//
// The fix (this PR) writes that JSON to files in the script's own temp work
// dir and hands python3 only the file paths. These tests prove:
//   1. the pre-fix script (HEAD) really does fail this way on a realistic
//      >128KiB fixture — using a `python3` stub that enforces Linux's limit,
//      since macOS does not;
//   2. the fixed script (working tree) parses the same fixture correctly and
//      produces the same dry-run report a small input gets — i.e. no
//      behavior change beyond surviving the size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildFixtures } from "./test/fixtures.mjs";
import { makeStubEnv } from "./test/stubs.mjs";
import { REPO_ROOT, runScript, checkoutHeadCopy } from "./test/run-script.mjs";

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

test("small input: original (HEAD) script produces the identical dry-run report", () => {
  const original = checkoutHeadCopy("scripts/cleanup-cloudrun-revisions.sh");
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 8, servingIndex: 0 });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  const fixed = runScript(FIXED_SCRIPT, dryRunArgs(), env);
  const before = runScript(original, dryRunArgs(), env);

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

test(">128KiB input: original (HEAD) script fails with the E2BIG-shaped error", () => {
  const original = checkoutHeadCopy("scripts/cleanup-cloudrun-revisions.sh");
  const fx = buildFixtures({
    project: PROJECT,
    service: SERVICE,
    count: 80,
    servingIndex: 0,
    tagged: { 30: "pr-99" },
    minScale: { 30: 1 },
  });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  const result = runScript(original, dryRunArgs(), env);

  // set -euo pipefail with no handler around the python3 call: the script
  // aborts and surfaces the failing command's own exit status verbatim.
  assert.equal(result.status, 126, `expected E2BIG-style exit 126, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /Argument list too long/);
});
