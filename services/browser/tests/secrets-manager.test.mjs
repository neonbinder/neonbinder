/**
 * Unit tests for SecretsManagerService version pruning (NEO-115).
 *
 * ## What is being pinned
 *
 * Secret Manager bills every version that is not DESTROYED and never reclaims
 * one on its own. The adapters write back a cached marketplace token on every
 * TTL expiry (BSC: hourly), so a per-user credential secret grows without
 * bound — that is how neonbinder-dev reached 1,326 live versions across 33
 * secrets. `updateCredentials` now destroys every other live version after a
 * successful write, keeping exactly one.
 *
 * Three properties in here must never be relaxed:
 *
 *  1. The just-written version is NEVER destroyed, and exclusion is by the
 *     explicit resource name returned from addSecretVersion — never by "first
 *     in the list". List order is a race against a concurrent write from
 *     another Cloud Run instance; losing that race destroys a live credential.
 *  2. Pruning is best-effort. A destroy/list failure must not propagate out of
 *     updateCredentials — a user saving their marketplace password must not
 *     see an error because cleanup hiccuped, and the credential write has
 *     already succeeded by then.
 *  3. Pruning is BOUNDED and CONCURRENT. The first cut destroyed every stale
 *     version inline and sequentially; against a 203-version backlog that put
 *     42 seconds inside a user-facing credential write and failed the E2E BSC
 *     auth step on PR #126. Both the cap and the concurrency are asserted
 *     below, because either regressing silently reintroduces that latency.
 *
 * ## Strategy
 *
 * Replace `@google-cloud/secret-manager` in the CJS require cache with a fake
 * whose constructor hands back a per-test spy object, THEN load the compiled
 * dist. No real GCP client is ever constructed, so the tests need no ADC.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Fake @google-cloud/secret-manager, installed before the dist module loads
// ---------------------------------------------------------------------------

/** The spy object the service will receive as `this.client` for the next test. */
let activeClient = null;

class FakeSecretManagerServiceClient {
  constructor() {
    // Returning an object from a constructor replaces `this`, so the service's
    // `new SecretManagerServiceClient()` yields the per-test spy.
    return activeClient;
  }
}

const sdkPath = require.resolve("@google-cloud/secret-manager");
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: { SecretManagerServiceClient: FakeSecretManagerServiceClient },
};

process.env.GOOGLE_CLOUD_PROJECT = "neonbinder-test";

const { SecretsManagerService } = require("../dist/services/secrets-manager");

const KEY = "buysportscards-credentials-user_abc";
const SECRET = `projects/neonbinder-test/secrets/${KEY}`;
const V = (n) => `${SECRET}/versions/${n}`;
/**
 * NEO-294: the log-safe form of a version name — the BARE secret id plus the
 * ordinal, never `projects/<project>/...`. The prune log lines emit THIS, and
 * the assertions below pin that in both directions: the short form present,
 * the fully-qualified form absent.
 */
const SHORT_V = (n) => `${KEY}/versions/${n}`;

const CREDS = {
  username: "seller@example.com",
  password: "hunter2-not-real",
  token: "tok-abc",
  expiresAt: 1234567890,
};

/**
 * Build a spy client.
 *
 * @param opts.createdVersion  name addSecretVersion reports back (null to omit)
 * @param opts.versions        what listSecretVersions returns
 * @param opts.addBehavior     "ok" | "notFound" (first add 404s, then succeeds)
 *                             | "alwaysNotFound" (every add 404s) | "boom"
 * @param opts.createBehavior  "ok" | "alreadyExists" (NEO-294: another writer
 *                             created the secret first) | "boom"
 * @param opts.destroyBehavior optional (name) => void; throw to simulate failure
 * @param opts.listThrows      when true, listSecretVersions rejects
 */
function makeClient({
  createdVersion = V(8),
  versions = [],
  addBehavior = "ok",
  createBehavior = "ok",
  destroyBehavior = null,
  listThrows = false,
} = {}) {
  const calls = { add: [], create: [], list: [], destroy: [] };
  let addCount = 0;
  // Concurrency probe. Each destroy increments on entry and decrements after
  // yielding to the event loop, so `maxInFlight` is the widest the fan-out
  // ever got: 1 under a `for … await` loop, N under Promise.allSettled.
  let inFlight = 0;
  const stats = { maxInFlight: 0 };

  return {
    calls,
    stats,
    async addSecretVersion(req) {
      addCount++;
      calls.add.push(req);
      if (addBehavior === "boom") {
        const err = new Error("PERMISSION_DENIED: nope");
        err.code = 7;
        throw err;
      }
      if (
        addBehavior === "alwaysNotFound" ||
        (addBehavior === "notFound" && addCount === 1)
      ) {
        // Shaped like the real client's: it names the secret resource, which
        // is exactly the detail that must never reach a caller or a log line.
        const err = new Error(`5 NOT_FOUND: Secret [${SECRET}] not found.`);
        err.code = 5;
        throw err;
      }
      return [createdVersion === null ? {} : { name: createdVersion }];
    },
    async createSecret(req) {
      calls.create.push(req);
      if (createBehavior === "alreadyExists") {
        // Verbatim shape of the error that turned a SUCCESSFUL marketplace
        // login into a 502 (NEO-294).
        const err = new Error(`6 ALREADY_EXISTS: Secret [${SECRET}] already exists.`);
        err.code = 6;
        throw err;
      }
      if (createBehavior === "boom") {
        const err = new Error("PERMISSION_DENIED: no secretmanager.secrets.create");
        err.code = 7;
        throw err;
      }
      return [{ name: SECRET }];
    },
    async listSecretVersions(req) {
      calls.list.push(req);
      if (listThrows) throw new Error("RESOURCE_EXHAUSTED: quota");
      return [versions];
    },
    async destroySecretVersion(req) {
      calls.destroy.push(req.name);
      inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
      if (destroyBehavior) destroyBehavior(req.name);
      return [{ name: req.name, state: "DESTROYED" }];
    },
  };
}

/** Names passed to destroySecretVersion, in call order. */
const destroyed = (client) => client.calls.destroy;

// Capture console.error/log so best-effort failures don't spam the test output
// — and so we can assert nothing secret leaks into them.
let capturedErrors = [];
let capturedLogs = [];
const realError = console.error;
const realLog = console.log;

beforeEach(() => {
  capturedErrors = [];
  capturedLogs = [];
  console.error = (...args) => capturedErrors.push(args.map(String).join(" "));
  console.log = (...args) => capturedLogs.push(args.map(String).join(" "));
});

afterEach(() => {
  console.error = realError;
  console.log = realLog;
  activeClient = null;
});

/** The cap in src/services/secrets-manager.ts. Kept in sync deliberately. */
const MAX_DESTROYS_PER_WRITE = 10;

/** N stale ENABLED versions, newest first, plus the kept version at the head. */
function backlog(keptVersion, staleCount) {
  const out = [{ name: keptVersion, state: "ENABLED" }];
  for (let i = staleCount; i >= 1; i--) out.push({ name: V(i), state: "ENABLED" });
  return out;
}

// ---------------------------------------------------------------------------
// Happy path: prune to exactly one
// ---------------------------------------------------------------------------

describe("SecretsManagerService.updateCredentials — prune to newest version", () => {
  it("destroys every other ENABLED version after a successful write", async () => {
    activeClient = makeClient({
      createdVersion: V(8),
      versions: [
        { name: V(8), state: "ENABLED" },
        { name: V(7), state: "ENABLED" },
        { name: V(6), state: "ENABLED" },
      ],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [V(7), V(6)], "should destroy the two older versions");
    assert.equal(activeClient.calls.add.length, 1, "should add exactly one version");
    assert.equal(
      activeClient.calls.list[0].parent,
      SECRET,
      "should list versions of the secret it just wrote",
    );
  });

  it("never destroys the version it just wrote, nor any version NEWER than it", async () => {
    // Simulates a concurrent write from another Cloud Run instance landing as
    // version 9 while this call created version 8. Version 9 sorts first in
    // Secret Manager's newest-first list order — "keep the first one" would
    // destroy our own live credential. Exclusion is by name, so v8 survives.
    //
    // v9 survives too, and that is the harder half: excluding only our OWN
    // version is what let two overlapping writers destroy each other's (see
    // the interleaving suite below). Ordinals come from the `/versions/N`
    // suffix, which Secret Manager assigns strictly increasing.
    activeClient = makeClient({
      createdVersion: V(8),
      versions: [
        { name: V(9), state: "ENABLED" },
        { name: V(8), state: "ENABLED" },
        { name: V(7), state: "ENABLED" },
      ],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.ok(
      !destroyed(activeClient).includes(V(8)),
      "must NEVER destroy the version this call created",
    );
    assert.deepEqual(
      destroyed(activeClient),
      [V(7)],
      "only OLDER versions are pruned; v9 was written after v8 and is another writer's",
    );
  });

  it("skips versions whose name has no parseable /versions/N ordinal", async () => {
    // An unrecognisable name is not evidence that a version is stale, and the
    // cost of guessing wrong is a destroyed live credential.
    activeClient = makeClient({
      createdVersion: V(5),
      versions: [
        { name: V(5), state: "ENABLED" },
        { name: `${SECRET}/versions/latest`, state: "ENABLED" },
        { name: V(4), state: "ENABLED" },
      ],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [V(4)]);
  });

  it("prunes NOTHING when the created version name has no parseable ordinal", async () => {
    // Same posture as an unknown created name: with no ordinal for the
    // survivor there is no way to tell stale from concurrent.
    activeClient = makeClient({
      createdVersion: `${SECRET}/versions/latest`,
      versions: [
        { name: `${SECRET}/versions/latest`, state: "ENABLED" },
        { name: V(4), state: "ENABLED" },
      ],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [], "unparseable survivor → prune nothing");
    assert.ok(
      capturedErrors.some((line) => line.includes("ordinal")),
      "skipping the prune must be visible in the logs",
    );
  });

  it("leaves a single-version secret untouched", async () => {
    activeClient = makeClient({
      createdVersion: V(1),
      versions: [{ name: V(1), state: "ENABLED" }],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [], "nothing to prune");
  });

  it("skips DESTROYED versions (re-destroying one is a FAILED_PRECONDITION error)", async () => {
    activeClient = makeClient({
      createdVersion: V(4),
      versions: [
        { name: V(4), state: "ENABLED" },
        { name: V(3), state: "DESTROYED" },
        { name: V(2), state: "DISABLED" },
        { name: V(1), state: "DESTROYED" },
      ],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    // DISABLED versions still bill and still accept destroy, so they are swept
    // too; DESTROYED ones are skipped.
    assert.deepEqual(destroyed(activeClient), [V(2)]);
  });

  it("skips versions with no name rather than issuing a nameless destroy", async () => {
    activeClient = makeClient({
      createdVersion: V(3),
      versions: [{ name: V(3), state: "ENABLED" }, { state: "ENABLED" }, { name: V(2), state: "ENABLED" }],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [V(2)]);
  });
});

// ---------------------------------------------------------------------------
// Concurrent writers: the secret must never end up with ZERO live versions
// ---------------------------------------------------------------------------
//
// Two unsynchronized writers on one key is reachable, not theoretical. Convex's
// per-(user,site) lock serialises writers within ONE deployment, but a preview
// deployment has its own `userProfiles` table — its own lock — while sharing the
// dev browser service, the dev GCP project and the same per-worker Clerk test
// users. A dev-branch E2E run overlapping a preview E2E run on the same worker
// index is exactly this.
//
// The failure it used to produce is total, not partial: zero ENABLED versions →
// getCredentials throws "No active version" → the route answers 404
// {"error":"Credentials not found"} → Convex string-matches that into
// `not_found` and calls removeSiteCredentialStatus. Credential and status flag
// both gone, from two ordinary logins.

/**
 * A single fake secret whose version list is SHARED by both writers, with a
 * barrier that holds every prune until both writes have landed. That barrier is
 * what reproduces the interleaving (A adds, B adds, A prunes, B prunes); left to
 * chance, the two calls would usually serialise and prove nothing.
 */
function makeConcurrentClient({ startOrdinal = 9 } = {}) {
  const versions = []; // newest-first, mirroring Secret Manager's list order
  let nextOrdinal = startOrdinal;
  let addCount = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });

  return {
    versions,
    async addSecretVersion() {
      const name = V(++nextOrdinal);
      versions.unshift({ name, state: "ENABLED" });
      if (++addCount === 2) releaseBarrier();
      return [{ name }];
    },
    async createSecret() {
      return [{ name: SECRET }];
    },
    async listSecretVersions() {
      await barrier; // both writes have landed before either prune reads
      return [versions.map((v) => ({ ...v }))];
    },
    async destroySecretVersion({ name }) {
      const target = versions.find((v) => v.name === name);
      // Mirror the real API: re-destroying is a FAILED_PRECONDITION error, and
      // the service must never issue one.
      assert.notEqual(
        target?.state,
        "DESTROYED",
        `destroySecretVersion called twice for ${name}`,
      );
      if (target) target.state = "DESTROYED";
      return [{ name, state: "DESTROYED" }];
    },
  };
}

describe("SecretsManagerService.updateCredentials — concurrent writers", () => {
  it("leaves the newest write ENABLED when two writers interleave", async () => {
    // Seed a couple of pre-existing versions so there is genuine backlog to
    // sweep alongside the contended ones.
    const client = makeConcurrentClient({ startOrdinal: 9 });
    client.versions.push({ name: V(9), state: "ENABLED" });
    client.versions.push({ name: V(8), state: "ENABLED" });
    activeClient = client;

    // Writer A lands v10, writer B lands v11. Before the ordinal guard, A's
    // prune destroyed v11 and B's prune destroyed v10 — zero survivors.
    await Promise.all([
      new SecretsManagerService().updateCredentials(KEY, CREDS),
      new SecretsManagerService().updateCredentials(KEY, CREDS),
    ]);

    const enabled = client.versions.filter((v) => v.state === "ENABLED");
    assert.ok(
      enabled.length >= 1,
      "a credential must NEVER be left with zero enabled versions",
    );
    assert.deepEqual(
      enabled.map((v) => v.name),
      [V(11)],
      "the newest write survives; both older versions and the loser are pruned",
    );
  });

  it("converges to keep-1 no matter which writer prunes first", async () => {
    // Same interleaving, no pre-existing backlog: the two contended versions
    // are the entire secret, which is the steady-state shape.
    const client = makeConcurrentClient({ startOrdinal: 0 });
    activeClient = client;

    await Promise.all([
      new SecretsManagerService().updateCredentials(KEY, CREDS),
      new SecretsManagerService().updateCredentials(KEY, CREDS),
    ]);

    const enabled = client.versions.filter((v) => v.state === "ENABLED");
    assert.equal(enabled.length, 1, "keep-1 still holds under contention");
    assert.equal(enabled[0].name, V(2), "and the survivor is the LATEST write");
  });
});

// ---------------------------------------------------------------------------
// Latency: the prune must be bounded and concurrent (PR #126 regression)
// ---------------------------------------------------------------------------

describe("SecretsManagerService.updateCredentials — prune is bounded and concurrent", () => {
  it("destroys at most MAX_DESTROYS_PER_WRITE versions in one call", async () => {
    // 203 enabled versions is the real backlog that produced the 42s write.
    activeClient = makeClient({
      createdVersion: V(999),
      versions: backlog(V(999), 202),
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.equal(
      destroyed(activeClient).length,
      MAX_DESTROYS_PER_WRITE,
      "a backlogged secret must converge over successive writes, not in one 42s request",
    );
    assert.ok(
      !destroyed(activeClient).includes(V(999)),
      "the cap must not weaken the never-destroy-our-own-version guarantee",
    );
    assert.ok(
      capturedLogs.some((line) => line.includes("cap reached")),
      "hitting the cap should be visible in the logs so a backlog is diagnosable",
    );
  });

  it("issues the capped batch concurrently, not one destroy at a time", async () => {
    activeClient = makeClient({
      createdVersion: V(999),
      versions: backlog(V(999), 50),
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    // The original `for … await` loop yields maxInFlight === 1 — that serial
    // round-tripping is exactly what cost 42 seconds.
    assert.equal(
      activeClient.stats.maxInFlight,
      MAX_DESTROYS_PER_WRITE,
      "all destroys in the batch must be in flight together",
    );
  });

  it("does not exceed the cap even when the kept version is not in the list", async () => {
    // Defensive: the survivor may have been listed after the cap boundary, or
    // not listed at all under eventual consistency. Neither may uncap the loop.
    activeClient = makeClient({
      createdVersion: V(999),
      versions: backlog(V(999), 30).filter((v) => v.name !== V(999)),
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.equal(destroyed(activeClient).length, MAX_DESTROYS_PER_WRITE);
  });

  it("stays quiet about the cap when the backlog fits in one batch", async () => {
    activeClient = makeClient({
      createdVersion: V(999),
      versions: backlog(V(999), 3),
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.equal(destroyed(activeClient).length, 3);
    assert.ok(
      !capturedLogs.some((line) => line.includes("cap reached")),
      "the steady-state path (1 stale version per write) must not log a backlog warning",
    );
  });

  it("one rejected destroy neither aborts nor unsettles the rest of the batch", async () => {
    activeClient = makeClient({
      createdVersion: V(999),
      versions: backlog(V(999), 20),
      destroyBehavior: (name) => {
        if (name === V(19)) throw new Error("PERMISSION_DENIED: no destroy permission");
      },
    });

    // Would reject if the implementation used Promise.all, and would leave an
    // unhandled rejection if the batch were fired without settling.
    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.equal(
      destroyed(activeClient).length,
      MAX_DESTROYS_PER_WRITE,
      "the failing version must not prevent its siblings from being attempted",
    );
    assert.ok(
      capturedErrors.some((line) => line.includes(SHORT_V(19))),
      "the rejected version should be named in the log so it can be chased",
    );
    // NEO-294: named by the log-SAFE form. The ordinal is what makes the line
    // chaseable and is deliberately kept; the project identifier is not.
    assert.ok(
      !capturedErrors.some((line) => line.includes(V(19))),
      "…but never by its fully-qualified resource name",
    );
    assert.equal(
      capturedErrors.filter((line) => line.includes("Failed to destroy")).length,
      1,
      "only the one genuine failure should be reported",
    );
  });
});

// ---------------------------------------------------------------------------
// Create-then-add path
// ---------------------------------------------------------------------------

describe("SecretsManagerService.updateCredentials — create-then-add path", () => {
  it("creates the secret, adds the version, and prunes with the created version excluded", async () => {
    activeClient = makeClient({
      addBehavior: "notFound",
      createdVersion: V(1),
      // A brand-new secret normally has one version; a stray extra proves the
      // prune actually runs on this path too.
      versions: [
        { name: V(1), state: "ENABLED" },
        { name: V(0), state: "ENABLED" },
      ],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.equal(activeClient.calls.create.length, 1, "should create the missing secret");
    assert.equal(activeClient.calls.add.length, 2, "should retry addSecretVersion after create");
    assert.deepEqual(destroyed(activeClient), [V(0)], "prune runs on the create-then-add path");
    assert.ok(
      !destroyed(activeClient).includes(V(1)),
      "must not destroy the version created on this path",
    );
  });
});

// ---------------------------------------------------------------------------
// NEO-294: the check-then-create race is idempotent, in BOTH orderings
// ---------------------------------------------------------------------------

/**
 * Secret Manager has no create-if-absent, so writing a key that may not exist
 * is unavoidably `addSecretVersion` → NOT_FOUND → `createSecret`, and the gap
 * between those two calls is a race. Both orderings are reachable in
 * production and both must converge on "a new version exists on this secret":
 *
 *   - we lose the create  ⇒ ALREADY_EXISTS is success-and-continue
 *   - we lose nothing     ⇒ NOT_FOUND on add creates, then adds
 *
 * What made this worth a suite of its own: the loser of the create race had
 * ALREADY performed a real, successful marketplace sign-in. Throwing there
 * reported a working login as a 502 (and on SportLots burned the adapter's
 * entire 5-attempt retry budget, because every attempt re-ran the same losing
 * race). Idempotence is the fix — NOT a retry or a sleep, and NOT a lock: the
 * two writers can be two Cloud Run instances or two Convex deployments sharing
 * one GCP project, which no in-process lock can see.
 */
describe("SecretsManagerService.updateCredentials — concurrent create (NEO-294)", () => {
  it("falls through to add-version when createSecret says ALREADY_EXISTS", async () => {
    activeClient = makeClient({
      addBehavior: "notFound", // first add 404s: the secret is absent when we look
      createBehavior: "alreadyExists", // …but another writer creates it before we do
      createdVersion: V(3),
      versions: [
        { name: V(3), state: "ENABLED" },
        { name: V(2), state: "ENABLED" },
      ],
    });

    // The assertion that matters most: this RESOLVES. A throw here is what the
    // adapter turns into "login failed" for a login that actually succeeded.
    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.equal(activeClient.calls.create.length, 1, "should have attempted the create");
    // The create is addressed by (project parent, bare secret id) while the
    // adds are addressed by the full secret resource name. All four arguments
    // are strings, so nothing but an assertion catches a swapped pair.
    assert.equal(activeClient.calls.create[0].parent, "projects/neonbinder-test");
    assert.equal(activeClient.calls.create[0].secretId, KEY);
    assert.equal(
      activeClient.calls.add.length,
      2,
      "should add the version to the secret the other writer created",
    );
    assert.deepEqual(
      activeClient.calls.add[1].parent,
      SECRET,
      "the second add targets the existing secret",
    );
    assert.deepEqual(
      destroyed(activeClient),
      [V(2)],
      "prune still runs, still excluding the version this call wrote",
    );
  });

  it("stores the credential payload even when it loses the create race", async () => {
    // Losing the race must not cost the write. Round-trip the payload back out
    // so this cannot pass on a call that was merely made but stored nothing.
    activeClient = makeClient({
      addBehavior: "notFound",
      createBehavior: "alreadyExists",
      createdVersion: V(1),
      versions: [{ name: V(1), state: "ENABLED" }],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    const written = JSON.parse(activeClient.calls.add[1].payload.data.toString("utf8"));
    assert.deepEqual(written, CREDS, "the losing writer's payload is still what landed");
  });

  it("never leaks the raw GCP error — no secret resource name in any log line", async () => {
    // The raw message is `6 ALREADY_EXISTS: Secret [projects/<p>/secrets/<id>]
    // already exists.` — it names the project and the per-user key. Before this
    // fix it escaped the sanitiser entirely (the create ran INSIDE the catch
    // that does the sanitising) and reached the login response body.
    activeClient = makeClient({
      addBehavior: "notFound",
      createBehavior: "alreadyExists",
      createdVersion: V(1),
      versions: [{ name: V(1), state: "ENABLED" }],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    const allOutput = [...capturedErrors, ...capturedLogs].join("\n");
    assert.ok(
      !allOutput.includes("ALREADY_EXISTS"),
      "the raw gRPC status must not be logged",
    );
    assert.ok(
      !allOutput.includes(CREDS.password) && !allOutput.includes(CREDS.token),
      "credential material must never reach the log",
    );
    // NEO-294: the half this test's NAME always claimed and never checked.
    // The fully-qualified name is `projects/<project>/secrets/<key>` — it
    // carries the GCP project identifier, which is the thing that escaped
    // onto a response body and started this ticket. The log line keeps the
    // bare secret id, so triage loses nothing.
    assert.ok(
      !allOutput.includes(SECRET),
      "no fully-qualified secret resource name in any log line",
    );
    assert.ok(
      !allOutput.includes("projects/neonbinder-test"),
      "no GCP project identifier in any log line",
    );
    assert.ok(
      capturedLogs.some((line) => line.includes("created concurrently")),
      "the lost race should still be observable server-side",
    );
    assert.ok(
      capturedLogs.some((line) => line.includes(KEY)),
      "…but the bare secret id IS logged, so the race stays triageable",
    );
  });

  it("is a fall-through, not a retry: a concurrent DELETE fails, and does not loop", async () => {
    // The one interleaving that must NOT converge: the secret is gone again
    // after our create, because an operator cleared this credential. Recreating
    // it would resurrect a credential the user just asked us to destroy — so
    // this propagates, sanitised, and the call count proves there is no loop.
    activeClient = makeClient({
      addBehavior: "alwaysNotFound",
      createBehavior: "ok",
    });

    await assert.rejects(
      () => new SecretsManagerService().updateCredentials(KEY, CREDS),
      (err) => {
        assert.equal(
          err.message,
          "Failed to update credentials",
          "the caller-facing message stays generic",
        );
        return true;
      },
    );

    assert.equal(activeClient.calls.create.length, 1, "creates at most once");
    assert.equal(activeClient.calls.add.length, 2, "adds at most twice — no ping-pong");
    assert.deepEqual(destroyed(activeClient), [], "a failed write must not prune");
  });

  it("sanitises a GENUINE create failure instead of propagating it raw", async () => {
    // PERMISSION_DENIED on createSecret is a real integration fault, not a
    // race. It must still reach the caller as the fixed generic string — this
    // is the path that previously bypassed the sanitiser altogether.
    activeClient = makeClient({ addBehavior: "notFound", createBehavior: "boom" });

    await assert.rejects(
      () => new SecretsManagerService().updateCredentials(KEY, CREDS),
      (err) => {
        assert.equal(err.message, "Failed to update credentials");
        assert.ok(
          !err.message.includes("PERMISSION_DENIED") && !err.message.includes(SECRET),
          "no raw status and no resource name in the thrown error",
        );
        return true;
      },
    );

    assert.ok(
      capturedErrors.some((line) => line.includes("Failed to update credentials for key")),
      "the real cause is logged server-side",
    );
    assert.ok(
      !capturedErrors.join("\n").includes(CREDS.password),
      "…but never with the payload that failed to write",
    );
  });
});

// ---------------------------------------------------------------------------
// Best-effort: prune failures never reach the caller
// ---------------------------------------------------------------------------

describe("SecretsManagerService.updateCredentials — prune is best-effort", () => {
  it("does not throw when destroySecretVersion fails, and continues the sweep", async () => {
    activeClient = makeClient({
      createdVersion: V(5),
      versions: [
        { name: V(5), state: "ENABLED" },
        { name: V(4), state: "ENABLED" },
        { name: V(3), state: "ENABLED" },
      ],
      destroyBehavior: (name) => {
        if (name === V(4)) throw new Error("PERMISSION_DENIED: no destroy permission");
      },
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(
      destroyed(activeClient),
      [V(4), V(3)],
      "one failing version must not abort the sweep",
    );
    assert.ok(
      capturedErrors.some((line) => line.includes(SHORT_V(4))),
      "the failure should be logged server-side, by its log-safe version name",
    );
    assert.ok(
      !capturedErrors.some((line) => line.includes(V(4))),
      "and never by the fully-qualified name, which carries the GCP project",
    );
  });

  it("does not throw when listSecretVersions fails", async () => {
    activeClient = makeClient({ createdVersion: V(2), listThrows: true });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [], "nothing destroyed when the list failed");
    assert.ok(
      capturedErrors.some((line) => line.includes("prune")),
      "the list failure should be logged server-side",
    );
  });

  it("prunes NOTHING when addSecretVersion returns no version name", async () => {
    // Without a known survivor, "destroy everything else" would destroy the
    // credential we just stored. Skip the prune entirely instead of guessing.
    activeClient = makeClient({
      createdVersion: null,
      versions: [
        { name: V(2), state: "ENABLED" },
        { name: V(1), state: "ENABLED" },
      ],
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [], "must not guess which version to keep");
    assert.equal(activeClient.calls.list.length, 0, "should not even list");
  });

  it("still throws the generic error when the WRITE itself fails, and prunes nothing", async () => {
    activeClient = makeClient({ addBehavior: "boom", versions: [{ name: V(1), state: "ENABLED" }] });

    await assert.rejects(
      () => new SecretsManagerService().updateCredentials(KEY, CREDS),
      /^Error: Failed to update credentials$/,
      "write failures must surface as the generic message, not the raw GCP error",
    );
    assert.deepEqual(destroyed(activeClient), [], "a failed write must not trigger a prune");
  });

  it("logs only the MESSAGE when the write fails — never the error object", async () => {
    // The sharpest case in the file: the call that failed is addSecretVersion,
    // whose REQUEST carries the credential payload. A GCP client error object
    // can hold the request it failed on, so logging the object writes the
    // credential into Cloud Logging on any transient write failure.
    activeClient = makeClient({ addBehavior: "boom", versions: [] });

    await assert.rejects(() => new SecretsManagerService().updateCredentials(KEY, CREDS));

    const logged = capturedErrors.join("\n");
    assert.ok(logged.includes("Failed to update credentials"), "the failure is still logged");
    for (const [field, value] of Object.entries(CREDS)) {
      assert.ok(
        !logged.includes(String(value)),
        `the ${field} value must never appear in a log line`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Security: nothing secret in the logs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NEO-141: the READ path — password-optional, and the field-stripping trap
// ---------------------------------------------------------------------------
//
// getCredentials builds its return value field-by-field from the parsed JSON.
// That is deliberate (the stored blob is untrusted input and must not be able
// to inject arbitrary keys), but it carries a trap: a field MISSING from the
// list is silently dropped on read. Before NEO-141 the list stopped at
// expiresAt, so a stored refreshToken would have been written and then
// discarded on the very next read — the write would look perfect and the
// rotation chain would break one hour later, far from the cause.
//
// It also required `password`, which made a password-less secret — now the
// steady state for every user — unreadable, surfacing as a 500 out of
// GET /credentials/:key/token.

/**
 * A spy client that can serve a stored payload back through accessSecretVersion,
 * so a test can drive a real store → read round trip.
 */
function makeReadClient({ payload, versions, state = "ENABLED" } = {}) {
  const calls = { add: [], access: [] };
  let stored = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), "utf8");
  return {
    calls,
    async addSecretVersion(req) {
      calls.add.push(req);
      stored = req.payload.data;
      return [{ name: V(1) }];
    },
    async createSecret() {
      return [{ name: SECRET }];
    },
    async listSecretVersions() {
      return [versions ?? [{ name: V(1), state }]];
    },
    async accessSecretVersion(req) {
      calls.access.push(req.name);
      return [{ payload: stored === undefined ? undefined : { data: stored } }];
    },
    async destroySecretVersion(req) {
      return [{ name: req.name, state: "DESTROYED" }];
    },
    /** Overwrite the stored blob with raw bytes (for malformed-payload tests). */
    _setRaw(text) {
      stored = Buffer.from(text, "utf8");
    },
  };
}

describe("SecretsManagerService.getCredentials — NEO-141 payload shape", () => {
  it("reads a PASSWORD-LESS secret without error (the new steady state)", async () => {
    // This threw `Invalid credentials format` before NEO-141, which is what
    // turned every token-less user secret into a 500 on the token endpoint.
    activeClient = makeReadClient({
      payload: { username: "seller@example.com", token: "placeholder-token" },
    });

    const creds = await new SecretsManagerService().getCredentials(KEY);

    assert.equal(creds.username, "seller@example.com");
    assert.equal(creds.password, undefined);
    assert.equal(creds.token, "placeholder-token");
  });

  it("reads a bare {username} secret — no token, no password", async () => {
    activeClient = makeReadClient({ payload: { username: "seller@example.com" } });

    const creds = await new SecretsManagerService().getCredentials(KEY);

    assert.deepEqual(creds, { username: "seller@example.com" });
  });

  it("ROUND-TRIPS refreshToken and refreshExpiresAt through store → read", async () => {
    // The guard on the field-stripping trap. A write that reads back without
    // its refresh fields breaks the rotation chain silently.
    activeClient = makeReadClient({});
    const service = new SecretsManagerService();

    await service.updateCredentials(KEY, {
      username: "seller@example.com",
      token: "placeholder-token",
      expiresAt: 1234567890,
      refreshToken: "placeholder-refresh",
      refreshExpiresAt: 987654321,
    });
    const creds = await service.getCredentials(KEY);

    assert.equal(creds.refreshToken, "placeholder-refresh", "refreshToken must survive the round trip");
    assert.equal(creds.refreshExpiresAt, 987654321, "refreshExpiresAt must survive the round trip");
    assert.equal(creds.token, "placeholder-token");
    assert.equal(creds.expiresAt, 1234567890);
    assert.equal(creds.username, "seller@example.com");
  });

  it("NEO-278: ROUND-TRIPS ssoCookies and ssoExpiresAt through store → read", async () => {
    // Same field-stripping trap as the refresh fields: a write that reads
    // back without its SSO cookie silently loses the way past the 24h
    // refresh window, and the loss shows up a day later, far from the cause.
    activeClient = makeReadClient({});
    const service = new SecretsManagerService();

    await service.updateCredentials(KEY, {
      username: "seller@example.com",
      token: "placeholder-token",
      expiresAt: 1234567890,
      refreshToken: "placeholder-refresh",
      refreshExpiresAt: 987654321,
      ssoCookies: { "x-ms-cpim-sso:tenant_0": "placeholder-sso-cookie" },
      ssoExpiresAt: 1700000000000,
    });
    const creds = await service.getCredentials(KEY);

    assert.deepEqual(
      creds.ssoCookies,
      { "x-ms-cpim-sso:tenant_0": "placeholder-sso-cookie" },
      "ssoCookies must survive the round trip",
    );
    assert.equal(creds.ssoExpiresAt, 1700000000000, "ssoExpiresAt must survive the round trip");
    assert.equal(creds.refreshToken, "placeholder-refresh", "and the refresh fields are untouched");
  });

  it("NEO-278: drops an ssoCookies entry carrying a control character", async () => {
    // RFC 6265 forbids them, and fetch() would reject the Cookie header with
    // a TypeError whose message quotes the entire header — the session.
    // Reject at the boundary so such a value never reaches a request.
    activeClient = makeReadClient({
      payload: {
        username: "seller@example.com",
        ssoCookies: {
          "x-ms-cpim-sso:ok": "fine",
          "x-ms-cpim-sso:crlf": "abc\r\nSet-Cookie: evil=1",
          "x-ms-cpim-sso:nul": "abc\u0000def",
          "x-ms-cpim-sso:\u0001name": "value",
        },
      },
    });
    const creds = await new SecretsManagerService().getCredentials(KEY);
    assert.deepEqual(creds.ssoCookies, { "x-ms-cpim-sso:ok": "fine" });
  });

  it("NEO-278: narrows a malformed ssoCookies blob instead of propagating it", async () => {
    // Non-string values, empty names/values, arrays and scalars are all
    // dropped one level down, exactly as the flat fields are.
    activeClient = makeReadClient({
      payload: {
        username: "seller@example.com",
        ssoCookies: { "x-ms-cpim-sso:a": "ok", "x-ms-cpim-sso:b": 42, "": "nameless", "x-ms-cpim-sso:c": "" },
        ssoExpiresAt: "later",
      },
    });
    let creds = await new SecretsManagerService().getCredentials(KEY);
    assert.deepEqual(creds.ssoCookies, { "x-ms-cpim-sso:a": "ok" });
    assert.equal(creds.ssoExpiresAt, undefined);

    for (const bad of [["x=y"], "x=y", 7, null, {}]) {
      activeClient = makeReadClient({ payload: { username: "seller@example.com", ssoCookies: bad } });
      creds = await new SecretsManagerService().getCredentials(KEY);
      assert.equal(creds.ssoCookies, undefined, `ssoCookies=${JSON.stringify(bad)} must read as absent`);
    }
  });

  it("still round-trips a canary payload's password", async () => {
    // The two canary secrets keep theirs; dropping it would break the NEO-43
    // login probes, which must perform a real password sign-in every 30 min.
    activeClient = makeReadClient({});
    const service = new SecretsManagerService();

    await service.updateCredentials(KEY, {
      username: "canary@example.com",
      password: "canary-placeholder-value",
    });
    const creds = await service.getCredentials(KEY);

    assert.equal(creds.password, "canary-placeholder-value");
  });

  it("drops unknown fields rather than passing untrusted keys through", async () => {
    activeClient = makeReadClient({
      payload: {
        username: "seller@example.com",
        __proto__stuff: "x",
        somethingElse: { nested: true },
      },
    });

    const creds = await new SecretsManagerService().getCredentials(KEY);

    assert.deepEqual(Object.keys(creds), ["username"]);
  });

  it("ignores fields stored with the wrong type instead of propagating them", async () => {
    activeClient = makeReadClient({
      payload: { username: "seller@example.com", expiresAt: "soon", refreshToken: 42 },
    });

    const creds = await new SecretsManagerService().getCredentials(KEY);

    assert.equal(creds.expiresAt, undefined);
    assert.equal(creds.refreshToken, undefined);
  });

  it("still rejects a payload with no username", async () => {
    activeClient = makeReadClient({ payload: { token: "placeholder-token" } });

    await assert.rejects(
      () => new SecretsManagerService().getCredentials(KEY),
      /Failed to retrieve credentials/,
    );
  });

  it("reports 'No active version' distinctly so the routes can 404 it", async () => {
    activeClient = makeReadClient({ versions: [{ name: V(1), state: "DESTROYED" }] });

    await assert.rejects(
      () => new SecretsManagerService().getCredentials(KEY),
      (err) => {
        // The routes match on this substring (routes/credentials.ts,
        // routes/easypost.ts) — not on the key, which NEO-294 removed.
        assert.match(err.message, /No active version/);
        assert.ok(
          !err.message.includes(KEY) && !err.message.includes("user_abc"),
          "the per-user key must not ride out on the thrown message",
        );
        return true;
      },
    );
  });

  it("never puts the credential key in any message it throws (NEO-294)", async () => {
    // `key` is `<site>-credentials-<clerkUserId>`, so it is a per-user
    // identifier. Two of these three branches used to interpolate it, and the
    // SportLots adapter's catch put the result straight into an HTTP response
    // body that Convex forwards to PostHog. Every branch must be a fixed
    // string; the key stays in the structured console.error, server-side.
    //
    // This is the assertion a future refactor would trip: re-adding
    // `: ${key}` "for triage" is exactly how the leak got there the first
    // time.
    const cases = [
      {
        name: "gRPC NOT_FOUND",
        client: {
          async listSecretVersions() {
            const err = new Error("5 NOT_FOUND: Secret [" + SECRET + "] not found.");
            err.code = 5;
            throw err;
          },
        },
      },
      {
        name: "no ENABLED version",
        client: {
          async listSecretVersions() {
            return [[{ name: V(1), state: "DESTROYED" }]];
          },
        },
      },
      {
        name: "unparseable payload",
        client: {
          async listSecretVersions() {
            return [[{ name: V(1), state: "ENABLED" }]];
          },
          async accessSecretVersion() {
            return [{ payload: { data: Buffer.from("{not-json", "utf8") } }];
          },
        },
      },
    ];

    for (const { name, client } of cases) {
      activeClient = client;
      await assert.rejects(
        () => new SecretsManagerService().getCredentials(KEY),
        (err) => {
          assert.ok(!err.message.includes(KEY), `${name}: the key must not be in the message`);
          assert.ok(
            !err.message.includes("user_abc"),
            `${name}: the clerk user id must not be in the message`,
          );
          assert.ok(
            !err.message.includes("projects/"),
            `${name}: no resource name (and so no project id) in the message`,
          );
          return true;
        },
        name,
      );
      // The key IS still available to triage, in the structured log line.
      assert.ok(
        capturedErrors.some((line) => line.includes(KEY)),
        `${name}: the key must still reach the server-side log`,
      );
      capturedErrors = [];
    }
  });

  it("never leaks payload text through a JSON parse error", async () => {
    // Node >= 20 embeds a window of the offending INPUT in SyntaxError.message
    // ("... is not valid JSON"). For this payload that window is credential
    // material, and it would otherwise reach both the log and the thrown error.
    activeClient = makeReadClient({ payload: {} });
    activeClient._setRaw('{"username":"seller@example.com","password":"leak-canary-value",}');

    await assert.rejects(
      () => new SecretsManagerService().getCredentials(KEY),
      (err) => {
        assert.ok(
          !err.message.includes("leak-canary-value"),
          "the thrown error must not carry payload text",
        );
        return true;
      },
    );

    const joined = capturedErrors.join("\n");
    assert.ok(joined.length > 0, "sanity: the failure was logged");
    assert.ok(
      !joined.includes("leak-canary-value"),
      "the log must not carry payload text either",
    );
  });
});

describe("SecretsManagerService.updateCredentials — prune logging discipline", () => {
  it("never writes credential material to the log on any prune failure path", async () => {
    activeClient = makeClient({
      createdVersion: V(3),
      versions: [
        { name: V(3), state: "ENABLED" },
        { name: V(2), state: "ENABLED" },
      ],
      // A hostile error that echoes the payload back, as a real API error
      // theoretically could. It must not be spilled verbatim into the log.
      destroyBehavior: () => {
        const err = new Error("boom");
        err.payload = JSON.stringify(CREDS);
        err.username = CREDS.username;
        throw err;
      },
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    const joined = capturedErrors.join("\n");
    assert.ok(capturedErrors.length > 0, "sanity: the failure was logged");
    for (const secret of [CREDS.username, CREDS.password, CREDS.token]) {
      assert.ok(!joined.includes(secret), `log must not contain ${secret === CREDS.password ? "the password" : secret}`);
    }
    // NEO-294 REVERSES the position this line used to pin. It previously read
    // "version resource names ARE safe to log and are useful" — half right.
    // The useful half is the ORDINAL, which tells one version from another and
    // is what makes a prune failure chaseable. The rest of the resource name
    // is `projects/<project>/secrets/<per-user-id>`, i.e. the GCP project
    // identifier, which is the thing this ticket exists to keep out of the
    // error path. So: keep the ordinal, drop the project.
    assert.ok(
      joined.includes(SHORT_V(2)),
      "the version must still be identifiable — the ordinal is the useful part",
    );
    assert.ok(
      !joined.includes(SECRET),
      "but never the fully-qualified resource name",
    );
    assert.ok(
      !joined.includes("projects/"),
      "and never the GCP project identifier, on any prune failure path",
    );
  });

  it("no prune path logs a fully-qualified resource name (NEO-294)", async () => {
    // The inverted position, pinned across EVERY prune log line at once rather
    // than one test per branch — a new prune log that reaches for `secretName`
    // fails here even if it invents its own message.
    const cases = [
      {
        name: "created version name unavailable",
        client: () => makeClient({ createdVersion: null, versions: [{ name: V(1), state: "ENABLED" }] }),
      },
      {
        name: "created version name has no parseable ordinal",
        client: () => makeClient({ createdVersion: SECRET, versions: [{ name: V(1), state: "ENABLED" }] }),
      },
      {
        name: "listSecretVersions fails",
        client: () => makeClient({ createdVersion: V(2), listThrows: true }),
      },
      {
        name: "destroy fails",
        client: () =>
          makeClient({
            createdVersion: V(3),
            versions: [
              { name: V(3), state: "ENABLED" },
              { name: V(2), state: "ENABLED" },
            ],
            destroyBehavior: () => {
              throw new Error("PERMISSION_DENIED: no destroy permission");
            },
          }),
      },
      {
        name: "per-write cap reached",
        client: () => makeClient({ createdVersion: V(999), versions: backlog(V(999), 50) }),
      },
    ];

    for (const { name, client } of cases) {
      capturedErrors = [];
      capturedLogs = [];
      activeClient = client();

      await new SecretsManagerService().updateCredentials(KEY, CREDS);

      const joined = [...capturedErrors, ...capturedLogs].join("\n");
      assert.ok(joined.length > 0, `${name}: sanity — this path does log`);
      assert.ok(
        !joined.includes("projects/"),
        `${name}: no GCP project identifier may reach the log`,
      );
      assert.ok(
        !joined.includes(SECRET),
        `${name}: no fully-qualified secret resource name may reach the log`,
      );
      assert.ok(
        joined.includes(KEY),
        `${name}: …but the bare secret id must still be there, or the line is unchaseable`,
      );
    }
  });
});
