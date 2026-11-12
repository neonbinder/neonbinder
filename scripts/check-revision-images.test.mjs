// NEO-484 cases are at the end of this file: a missing TAGGED image fails,
// and every serving/tagged pin is classified tagged / child-of-index /
// UNPROTECTED, with a warning for pins kept only by an aging pr- tag.
//
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

// NEO-484: the protection pass reads the package's version listing. By
// default every fixture digest is its own tagged version, i.e. protected.
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const INDEX = "application/vnd.oci.image.index.v1+json";
function digestOf(ref) {
  return ref.split("@")[1];
}
function taggedVersions(fx, count, { createTime = new Date().toISOString() } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      version: digestOf(fx.imageAt(i)),
      tags: [`sha${i}`],
      createTime,
      metadata: { mediaType: MANIFEST },
    });
  }
  return out;
}

// Per-revision existence lines only: the protection pass added in NEO-484
// prints more, and the pre-NEO-309 copy cannot.
function existenceLines(stdout) {
  return stdout
    .split("\n")
    .filter((l) => /^ {2}(ok|MISSING|missing|skip|\?) /.test(l))
    .join("\n");
}

test("small input: fixed script reports every image present", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 5, servingIndex: 0 });
  const { env } = makeStubEnv({
    service: SERVICE,
    svc: fx.service,
    rev: fx.revisions,
    versions: taggedVersions(fx, 5),
  });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /checked=5 skipped=0 missing_serving=0 missing_tagged=0 missing_other=0/,
  );
  assert.match(result.stdout, /unprotected=0 pr_warn=0/);
  assert.match(result.stdout, /OK: every traffic-serving revision's image is present\./);
});

test("small input: pre-fix script produces the identical per-revision report", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 5, servingIndex: 0 });
  const { env } = makeStubEnv({
    service: SERVICE,
    svc: fx.service,
    rev: fx.revisions,
    versions: taggedVersions(fx, 5),
  });

  const fixed = runScript(FIXED_SCRIPT, args(), env);
  const before = runScript(PRE_FIX_SCRIPT, args(), env);

  assert.equal(before.status, 0, before.stderr || before.stdout);
  assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.ok(existenceLines(fixed.stdout).length > 0);
  assert.equal(existenceLines(before.stdout), existenceLines(fixed.stdout));
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
    const { env } = makeStubEnv({
      service: SERVICE,
      svc: fx.service,
      rev: fx.revisions,
      versions: taggedVersions(fx, 80),
    });
    const result = runScript(FIXED_SCRIPT, args(), env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /checked=80 skipped=0 missing_serving=0 missing_tagged=0 missing_other=0/,
    );
    assert.match(result.stdout, /OK: every traffic-serving revision's image is present\./);
  }

  // The serving revision's image has been collected.
  {
    const { env } = makeStubEnv({
      service: SERVICE,
      svc: fx.service,
      rev: fx.revisions,
      missingImages: [fx.imageAt(0)],
      versions: taggedVersions(fx, 80),
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

// ── NEO-484 ──────────────────────────────────────────────────────────────

test("a TAGGED revision whose image is missing now fails", () => {
  const fx = buildFixtures({
    project: PROJECT,
    service: SERVICE,
    count: 5,
    servingIndex: 0,
    tagged: { 2: "pr-7" },
  });
  const { env } = makeStubEnv({
    service: SERVICE,
    svc: fx.service,
    rev: fx.revisions,
    missingImages: [fx.imageAt(2)],
    versions: taggedVersions(fx, 5),
  });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /MISSING {2}.*\(tagged\)/);
  assert.match(result.stdout, /missing_tagged=1/);
  assert.match(result.stdout, /FAIL: 1 tagged revision\(s\)/);
});

test("an IDLE revision whose image is missing still only notes it", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 5, servingIndex: 0 });
  const { env } = makeStubEnv({
    service: SERVICE,
    svc: fx.service,
    rev: fx.revisions,
    missingImages: [fx.imageAt(3)],
    versions: taggedVersions(fx, 5),
  });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /missing_other=1/);
  assert.match(result.stdout, /NOTE: 1 idle revision\(s\)/);
});

test("an untagged serving pin listed by a TAGGED index is child-of-index", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 3, servingIndex: 0 });
  const child = digestOf(fx.imageAt(0));
  const index = `sha256:${"a".repeat(64)}`;
  const versions = taggedVersions(fx, 3);
  versions[0].tags = [];
  versions.push({
    version: index,
    tags: ["abc123", "latest"],
    createTime: new Date().toISOString(),
    metadata: { mediaType: INDEX },
  });
  const { env } = makeStubEnv({
    service: SERVICE,
    svc: fx.service,
    rev: fx.revisions,
    versions,
    indexes: { [index]: { mediaType: INDEX, manifests: [{ digest: child, mediaType: MANIFEST }] } },
  });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /child-of-index +\S+ +\(SERVING\) tags=abc123,latest/);
  assert.match(result.stdout, /unprotected=0/);
});

test("an untagged serving pin with no tagged parent is UNPROTECTED and fails", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 3, servingIndex: 0 });
  const child = digestOf(fx.imageAt(0));
  const index = `sha256:${"b".repeat(64)}`;
  const versions = taggedVersions(fx, 3);
  versions[0].tags = [];
  // Its parent index lost its tag (a later push moved it), so it no longer
  // protects the child.
  versions.push({
    version: index,
    tags: [],
    createTime: new Date().toISOString(),
    metadata: { mediaType: INDEX },
  });
  const { env } = makeStubEnv({
    service: SERVICE,
    svc: fx.service,
    rev: fx.revisions,
    versions,
    indexes: { [index]: { mediaType: INDEX, manifests: [{ digest: child, mediaType: MANIFEST }] } },
  });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /UNPROTECTED +\S+ +\(SERVING\)/);
  assert.match(result.stdout, /unprotected=1/);
  assert.match(result.stdout, /FAIL: 1 serving or tagged revision\(s\) pin a digest that nothing protects/);
});

test("a pin kept only by an old pr- tag warns but passes", () => {
  const fx = buildFixtures({
    project: PROJECT,
    service: SERVICE,
    count: 3,
    servingIndex: 0,
    tagged: { 1: "pr-9" },
  });
  const versions = taggedVersions(fx, 3);
  versions[1].tags = ["pr-9"];
  versions[1].createTime = new Date(Date.now() - 12 * 86_400_000).toISOString();
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions, versions });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /tagged +\S+ +\(tagged\) tags=pr-9 .*WARN only pr- tags, 12\.0 days old/);
  assert.match(result.stdout, /pr_warn=1/);
  assert.match(result.stdout, /::warning::1 pinned image/);
});

test("a young pr- pin does not warn", () => {
  const fx = buildFixtures({
    project: PROJECT,
    service: SERVICE,
    count: 3,
    servingIndex: 0,
    tagged: { 1: "pr-9" },
  });
  const versions = taggedVersions(fx, 3);
  versions[1].tags = ["pr-9"];
  versions[1].createTime = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions, versions });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pr_warn=0/);
});

test("a pin absent from the package listing fails closed (exit 2)", () => {
  const fx = buildFixtures({ project: PROJECT, service: SERVICE, count: 3, servingIndex: 0 });
  const { env } = makeStubEnv({ service: SERVICE, svc: fx.service, rev: fx.revisions, versions: [] });

  const result = runScript(FIXED_SCRIPT, args(), env);

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /protection check failed/);
});
