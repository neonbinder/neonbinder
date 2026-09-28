// Regression coverage for NEO-309: check-revision-images.sh used to hand the
// full `gcloud run services describe` / `revisions list` JSON to python3
// through environment variables — same MAX_ARG_STRLEN (~128KiB) exec limit
// as cleanup-cloudrun-revisions.sh (see that script's test file header for
// the measured sizes and why a stub is needed to reproduce it off Linux).
//
// Unlike cleanup-cloudrun-revisions.sh, the original script already caught
// the parse failure via `|| { ...; exit 2; }` (it runs under `set -uo
// pipefail`, not `-e`) — but with a generic "failed to parse service/revision
// JSON" message that named neither the cause nor python3's own error. This
// PR fixes the size bug AND makes that message name what actually failed.
//
// The pre-fix script is a committed, frozen copy under
// scripts/test/fixtures/pre-neo-309/ (see that directory's README), not a
// `git show HEAD:...` lookup — CI checkouts are shallow, and a HEAD-keyed
// lookup starts asserting the wrong thing the moment this fix's own commit
// becomes HEAD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildFixtures } from "./test/fixtures.mjs";
import { makeStubEnv } from "./test/stubs.mjs";
import { REPO_ROOT, runScript, preNeo309Fixture } from "./test/run-script.mjs";

const FIXED_SCRIPT = join(REPO_ROOT, "scripts", "check-revision-images.sh");
const PRE_FIX_SCRIPT = preNeo309Fixture("check-revision-images.sh");
const PROJECT = "test-project";
const SERVICE = "test-service";

function args() {
  return ["--project", PROJECT, "--service", SERVICE, "--region", "us-central1"];
}

test("small input: fixed script reports every image present", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 5, servingIndex: 0 });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /checked=5 skipped=0 missing_serving=0 missing_other=0/);
  assert.match(result.stdout, /OK: every traffic-serving revision's image is present\./);
});

test("small input: pre-fix script produces the identical report", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 5, servingIndex: 0 });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  const fixed = runScript(FIXED_SCRIPT, args(), env);
  const before = runScript(PRE_FIX_SCRIPT, args(), env);

  assert.equal(before.status, 0, before.stderr || before.stdout);
  assert.equal(before.stdout, fixed.stdout);
});

test(">128KiB input: fixed script still parses correctly and detects a missing SERVING image", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 80, servingIndex: 0 });
  const revJsonSize = Buffer.byteLength(JSON.stringify(fx.revisions));
  assert.ok(
    revJsonSize > 131072,
    `fixture is only ${revJsonSize} bytes — must exceed Linux's 128KiB MAX_ARG_STRLEN to exercise the bug`,
  );

  // All present.
  {
    const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });
    const result = runScript(FIXED_SCRIPT, args(), env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /checked=80 skipped=0 missing_serving=0 missing_other=0/);
    assert.match(result.stdout, /OK: every traffic-serving revision's image is present\./);
  }

  // The serving revision's image has been collected.
  {
    const { env } = makeStubEnv({
      service: SERVICE,
      svc: fx.service,
      rev: fx.revisions,
      missingImages: [fx.imageAt(0)],
    });
    const result = runScript(FIXED_SCRIPT, args(), env);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /MISSING {2}.*\(SERVING\)/);
    assert.match(result.stdout, /FAIL: 1 traffic-serving revision\(s\)/);
  }
});

test(">128KiB input: pre-fix script fails closed with a generic, unhelpful message", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 80, servingIndex: 0 });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions });

  const result = runScript(PRE_FIX_SCRIPT, args(), env);

  assert.equal(result.status, 2, `expected the script's own caught-failure exit 2, got ${result.status}`);
  assert.match(result.stderr, /ERROR: failed to parse service\/revision JSON$/m);
});
