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
 * @param opts.addBehavior     "ok" | "notFound" (first add 404s, then succeeds) | "boom"
 * @param opts.destroyBehavior optional (name) => void; throw to simulate failure
 * @param opts.listThrows      when true, listSecretVersions rejects
 */
function makeClient({
  createdVersion = V(8),
  versions = [],
  addBehavior = "ok",
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
      if (addBehavior === "notFound" && addCount === 1) {
        const err = new Error("Secret not found");
        err.code = 5;
        throw err;
      }
      return [createdVersion === null ? {} : { name: createdVersion }];
    },
    async createSecret(req) {
      calls.create.push(req);
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
      capturedErrors.some((line) => line.includes(V(19))),
      "the rejected version should be named in the log so it can be chased",
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
      capturedErrors.some((line) => line.includes(V(4))),
      "the failure should be logged server-side",
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
      /No active version found for key/,
    );
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
    assert.ok(joined.includes(V(2)), "version resource names ARE safe to log and are useful");
  });
});
