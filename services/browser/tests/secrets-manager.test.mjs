/**
 * Unit tests for SecretsManagerService: the keep-one write (NEO-115), the
 * list-free read and prune (NEO-385), and the quota retry (NEO-385).
 *
 * ## What is being pinned
 *
 * Secret Manager bills every version that is not DESTROYED and never reclaims
 * one on its own. The adapters write back a cached marketplace token on every
 * TTL expiry (BSC: hourly), so a per-user credential secret grows without
 * bound unless each write cleans up after itself. `updateCredentials` destroys
 * the ONE version its write superseded, `versions/<N-1>`, keeping exactly one.
 *
 * NEO-385 removed every ListSecretVersions call. A list is metered at 600/min
 * per project and returns every DESTROYED version too, and parallel PR E2E
 * runs re-signing-in all their test accounts at once ran that quota out:
 * token reads came back 500 and the specs stalled. Reads now go straight to
 * `versions/latest`, and the prune addresses `N-1` by ordinal.
 *
 * Properties in here that must never be relaxed:
 *
 *  1. No path lists. get, exists, update: every spy below throws from
 *     listSecretVersions and records the call, and the tests assert zero.
 *  2. The write destroys exactly `N-1`, where N is the ordinal of the version
 *     this call created — never the created version, never a newer one. Two
 *     interleaved writers (A adds v10, B adds v11) each destroy their own N-1,
 *     and v11 survives. Destroying "everything but mine" is what once zeroed a
 *     secret.
 *  3. No known created ordinal ⇒ nothing destroyed. N == 1 ⇒ nothing to do.
 *  4. Pruning is best-effort. A destroy failure never propagates out of
 *     updateCredentials, and NOT_FOUND / FAILED_PRECONDITION (already gone,
 *     usually a concurrent writer) are silent.
 *  5. Nothing secret in any log line, and no fully-qualified resource name
 *     (NEO-294): the bare secret id plus the ordinal only.
 *  6. RESOURCE_EXHAUSTED is retried twice (400 ms, then 1200 ms, each jittered
 *     to 0.5x-1.5x); every other error propagates at once. Reads pass
 *     ACCESS_CALL_OPTIONS so the client library adds no retry of its own.
 *
 * ## Strategy
 *
 * Replace `@google-cloud/secret-manager` in the CJS require cache with a fake
 * whose constructor hands back a per-test spy object, THEN load the compiled
 * dist. No real GCP client is ever constructed, so the tests need no ADC. The
 * retry backoff is driven with node:test's mocked setTimeout, so the suite
 * spends no real time in it and can pin the exact delays.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
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

const {
  SecretsManagerService,
  withQuotaRetry,
  ACCESS_CALL_OPTIONS,
} = require("../dist/services/secrets-manager");

const KEY = "buysportscards-credentials-user_abc";
const SECRET = `projects/neonbinder-test/secrets/${KEY}`;
const V = (n) => `${SECRET}/versions/${n}`;
const LATEST = `${SECRET}/versions/latest`;
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

/** An error shaped like the client's: a gRPC status on `code`. */
function grpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
const notFound = () => grpcError(5, `5 NOT_FOUND: Secret [${SECRET}] not found.`);
const failedPrecondition = () =>
  grpcError(9, `9 FAILED_PRECONDITION: ${V(1)} is in DESTROYED state.`);
const quotaExhausted = () =>
  grpcError(8, "8 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Read requests'");

/**
 * NEO-385 tripwire. Any call is recorded and refused, so a regression that
 * reintroduces a list both fails loudly and shows up in `calls.list`.
 */
function listTripwire(calls) {
  return async function listSecretVersions(req) {
    calls.list.push(req);
    throw new Error("listSecretVersions must never be called (NEO-385)");
  };
}

/**
 * Build a spy client for the write path.
 *
 * @param opts.createdVersion  name addSecretVersion reports back (null to omit)
 * @param opts.addBehavior     "ok" | "notFound" (first add 404s, then succeeds)
 *                             | "alwaysNotFound" (every add 404s) | "boom"
 *                             | "quotaOnce" (first add RESOURCE_EXHAUSTED)
 * @param opts.createBehavior  "ok" | "alreadyExists" (NEO-294: another writer
 *                             created the secret first) | "boom"
 * @param opts.destroyBehavior optional (name, attempt) => void; throw to simulate failure
 */
function makeClient({
  createdVersion = V(8),
  addBehavior = "ok",
  createBehavior = "ok",
  destroyBehavior = null,
} = {}) {
  const calls = { add: [], create: [], list: [], destroy: [], access: [] };
  let addCount = 0;

  return {
    calls,
    listSecretVersions: listTripwire(calls),
    async accessSecretVersion(req) {
      calls.access.push(req.name);
      throw new Error("the write path must not read");
    },
    async addSecretVersion(req) {
      addCount++;
      calls.add.push(req);
      if (addBehavior === "boom") {
        throw grpcError(7, "PERMISSION_DENIED: nope");
      }
      if (addBehavior === "quotaOnce" && addCount === 1) {
        throw quotaExhausted();
      }
      if (
        addBehavior === "alwaysNotFound" ||
        (addBehavior === "notFound" && addCount === 1)
      ) {
        // Shaped like the real client's: it names the secret resource, which
        // is exactly the detail that must never reach a caller or a log line.
        throw notFound();
      }
      return [createdVersion === null ? {} : { name: createdVersion }];
    },
    async createSecret(req) {
      calls.create.push(req);
      if (createBehavior === "alreadyExists") {
        // Verbatim shape of the error that turned a SUCCESSFUL marketplace
        // login into a 502 (NEO-294).
        throw grpcError(6, `6 ALREADY_EXISTS: Secret [${SECRET}] already exists.`);
      }
      if (createBehavior === "boom") {
        throw grpcError(7, "PERMISSION_DENIED: no secretmanager.secrets.create");
      }
      return [{ name: SECRET }];
    },
    async destroySecretVersion(req) {
      calls.destroy.push(req.name);
      if (destroyBehavior) {
        destroyBehavior(req.name, calls.destroy.filter((n) => n === req.name).length);
      }
      return [{ name: req.name, state: "DESTROYED" }];
    },
  };
}

/** Names passed to destroySecretVersion, in call order. */
const destroyed = (client) => client.calls.destroy;

// Capture console.error/log/warn so best-effort failures don't spam the test
// output — and so we can assert nothing secret leaks into them.
let capturedErrors = [];
let capturedLogs = [];
let capturedWarns = [];
const realError = console.error;
const realLog = console.log;
const realWarn = console.warn;

beforeEach(() => {
  capturedErrors = [];
  capturedLogs = [];
  capturedWarns = [];
  console.error = (...args) => capturedErrors.push(args.map(String).join(" "));
  console.log = (...args) => capturedLogs.push(args.map(String).join(" "));
  console.warn = (...args) => capturedWarns.push(args.map(String).join(" "));
});

afterEach(() => {
  console.error = realError;
  console.log = realLog;
  console.warn = realWarn;
  mock.timers.reset();
  mock.restoreAll();
  activeClient = null;
});

/** Let every pending promise continuation run (setImmediate is not mocked). */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drive `promise` through the whole quota backoff schedule under mocked
 * timers, then hand it back. The delays are jittered to 0.5x-1.5x of the
 * 400 ms / 1200 ms bases, so each step ticks the UPPER bound. The caller
 * must have called `mock.timers.enable({ apis: ["setTimeout"] })` first.
 */
async function throughBackoff(promise) {
  // Mark handled now: a rejection that lands while we tick would otherwise be
  // reported as unhandled before the caller gets to await it.
  promise.catch(() => {});
  for (const ms of [600, 1800]) {
    await settle();
    mock.timers.tick(ms);
  }
  await settle();
  return promise;
}

// ---------------------------------------------------------------------------
// Happy path: destroy exactly N-1
// ---------------------------------------------------------------------------

describe("SecretsManagerService.updateCredentials — destroys the superseded version", () => {
  it("destroys exactly versions/<N-1> after a successful write, without listing", async () => {
    activeClient = makeClient({ createdVersion: V(8) });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [V(7)], "only the version this write superseded");
    assert.equal(activeClient.calls.add.length, 1, "should add exactly one version");
    assert.equal(activeClient.calls.add[0].parent, SECRET, "adds to the secret named by the key");
    assert.equal(activeClient.calls.list.length, 0, "NEO-385: the write never lists");
  });

  it("never destroys the version it just wrote, nor any version NEWER than it", async () => {
    // A concurrent write from another Cloud Run instance may have landed v9
    // while this call created v8. The only target this call may ever address
    // is v7: anything at or above its own ordinal is live or someone else's.
    activeClient = makeClient({ createdVersion: V(8) });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    const ordinals = destroyed(activeClient).map((name) => Number(name.split("/").pop()));
    assert.ok(
      ordinals.every((n) => n < 8),
      `must NEVER destroy the created version or a newer one (destroyed ${ordinals})`,
    );
    assert.equal(ordinals.length, 1, "one destroy per write, not a sweep");
  });

  it("destroys nothing when the created version is the secret's first (N == 1)", async () => {
    activeClient = makeClient({ createdVersion: V(1) });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [], "there is no versions/0");
    assert.equal(capturedErrors.length, 0, "and nothing to complain about");
  });

  it("destroys NOTHING when the created version name has no parseable ordinal", async () => {
    // With no ordinal for the survivor there is no safe N-1 to address, and
    // the cost of guessing wrong is a destroyed live credential.
    activeClient = makeClient({ createdVersion: LATEST });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [], "unparseable created name → destroy nothing");
    assert.ok(
      capturedErrors.some((line) => line.includes("unparseable")),
      "skipping the prune must be visible in the logs",
    );
  });

  it("destroys NOTHING when addSecretVersion returns no version name", async () => {
    // Without a known created version, any target is a guess.
    activeClient = makeClient({ createdVersion: null });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [], "must not guess which version to destroy");
    assert.ok(
      capturedErrors.some((line) => line.includes("Skipping version prune")),
      "skipping the prune must be visible in the logs",
    );
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
 * A single fake secret whose versions are SHARED by both writers, with a
 * barrier that holds every destroy until both writes have landed. That barrier
 * is what reproduces the interleaving (A adds, B adds, A prunes, B prunes);
 * left to chance, the two calls would usually serialise and prove nothing.
 */
function makeConcurrentClient({ startOrdinal = 9 } = {}) {
  const calls = { list: [] };
  const versions = new Map(); // name → state
  let nextOrdinal = startOrdinal;
  let addCount = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });

  return {
    calls,
    versions,
    listSecretVersions: listTripwire(calls),
    async addSecretVersion() {
      const name = V(++nextOrdinal);
      versions.set(name, "ENABLED");
      if (++addCount === 2) releaseBarrier();
      return [{ name }];
    },
    async createSecret() {
      return [{ name: SECRET }];
    },
    async destroySecretVersion({ name }) {
      await barrier; // both writes have landed before either prune runs
      // Mirror the real API: an unknown version is NOT_FOUND, re-destroying is
      // FAILED_PRECONDITION. The service treats both as an ordinary race.
      if (!versions.has(name)) throw notFound();
      if (versions.get(name) === "DESTROYED") throw failedPrecondition();
      versions.set(name, "DESTROYED");
      return [{ name, state: "DESTROYED" }];
    },
  };
}

const enabledNames = (client) =>
  [...client.versions].filter(([, state]) => state === "ENABLED").map(([name]) => name);

describe("SecretsManagerService.updateCredentials — concurrent writers", () => {
  it("leaves the newest write ENABLED when two writers interleave", async () => {
    // A pre-existing v9 is the live version both writers supersede.
    const client = makeConcurrentClient({ startOrdinal: 9 });
    client.versions.set(V(9), "ENABLED");
    activeClient = client;

    // Writer A lands v10, writer B lands v11. A destroys v9, B destroys v10.
    await Promise.all([
      new SecretsManagerService().updateCredentials(KEY, CREDS),
      new SecretsManagerService().updateCredentials(KEY, CREDS),
    ]);

    assert.deepEqual(
      enabledNames(client),
      [V(11)],
      "the newest write survives; each writer destroyed only its own N-1",
    );
    assert.equal(client.calls.list.length, 0, "and neither writer listed");
    assert.equal(capturedErrors.length, 0, "an ordinary interleaving logs no failure");
  });

  it("converges to keep-1 on a fresh secret", async () => {
    // No pre-existing version: the two contended versions are the entire
    // secret. A (v1) has no N-1; B (v2) destroys v1.
    const client = makeConcurrentClient({ startOrdinal: 0 });
    activeClient = client;

    await Promise.all([
      new SecretsManagerService().updateCredentials(KEY, CREDS),
      new SecretsManagerService().updateCredentials(KEY, CREDS),
    ]);

    assert.deepEqual(enabledNames(client), [V(2)], "keep-1 holds, and the survivor is the LATEST write");
  });
});

// ---------------------------------------------------------------------------
// Create-then-add path
// ---------------------------------------------------------------------------

describe("SecretsManagerService.updateCredentials — create-then-add path", () => {
  it("creates the secret, adds the version, and destroys N-1 of the created version", async () => {
    // A secret normally starts at v1; a later ordinal (the secret was deleted
    // and re-created, or an id was reused) proves the prune runs on this path
    // too, addressed off the version the SECOND add reported.
    activeClient = makeClient({ addBehavior: "notFound", createdVersion: V(4) });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.equal(activeClient.calls.create.length, 1, "should create the missing secret");
    assert.equal(activeClient.calls.add.length, 2, "should retry addSecretVersion after create");
    assert.deepEqual(destroyed(activeClient), [V(3)], "prune runs on the create-then-add path");
    assert.equal(activeClient.calls.list.length, 0);
  });

  it("destroys nothing for a brand-new secret's first version", async () => {
    activeClient = makeClient({ addBehavior: "notFound", createdVersion: V(1) });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), []);
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
      "prune still runs, addressed off the version this call wrote",
    );
  });

  it("stores the credential payload even when it loses the create race", async () => {
    // Losing the race must not cost the write. Round-trip the payload back out
    // so this cannot pass on a call that was merely made but stored nothing.
    activeClient = makeClient({
      addBehavior: "notFound",
      createBehavior: "alreadyExists",
      createdVersion: V(1),
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
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    const allOutput = [...capturedErrors, ...capturedLogs, ...capturedWarns].join("\n");
    assert.ok(
      !allOutput.includes("ALREADY_EXISTS"),
      "the raw gRPC status must not be logged",
    );
    assert.ok(
      !allOutput.includes(CREDS.password) && !allOutput.includes(CREDS.token),
      "credential material must never reach the log",
    );
    // NEO-294: the fully-qualified name is `projects/<project>/secrets/<key>` —
    // it carries the GCP project identifier, which is the thing that escaped
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
  it("does not throw when destroySecretVersion fails, and logs it by its short name", async () => {
    activeClient = makeClient({
      createdVersion: V(5),
      destroyBehavior: () => {
        throw grpcError(7, "PERMISSION_DENIED: no destroy permission");
      },
    });

    await new SecretsManagerService().updateCredentials(KEY, CREDS);

    assert.deepEqual(destroyed(activeClient), [V(4)], "attempted once — PERMISSION_DENIED is not retried");
    assert.ok(
      capturedErrors.some((line) => line.includes("Failed to destroy") && line.includes(SHORT_V(4))),
      "the failure should be logged server-side, by its log-safe version name",
    );
    assert.ok(
      !capturedErrors.some((line) => line.includes(V(4))),
      "and never by the fully-qualified name, which carries the GCP project",
    );
  });

  for (const [label, makeErr] of [
    ["NOT_FOUND", notFound],
    ["FAILED_PRECONDITION", failedPrecondition],
  ]) {
    it(`is SILENT when the destroy answers ${label} (already gone: a concurrent writer)`, async () => {
      activeClient = makeClient({
        createdVersion: V(5),
        destroyBehavior: () => {
          throw makeErr();
        },
      });

      await new SecretsManagerService().updateCredentials(KEY, CREDS);

      assert.deepEqual(destroyed(activeClient), [V(4)], "attempted exactly once, not retried");
      assert.equal(capturedErrors.length, 0, `${label} is the normal outcome of a race, not a failure`);
      assert.equal(capturedWarns.length, 0);
    });
  }

  it("still throws the generic error when the WRITE itself fails, and prunes nothing", async () => {
    activeClient = makeClient({ addBehavior: "boom" });

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
    activeClient = makeClient({ addBehavior: "boom" });

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
// NEO-385: credentialsExist reads versions/latest, never a list
// ---------------------------------------------------------------------------

describe("SecretsManagerService.credentialsExist — latest version, no list (NEO-385)", () => {
  function makeExistsClient(accessResult) {
    const calls = { list: [], access: [], accessOptions: [] };
    return {
      calls,
      listSecretVersions: listTripwire(calls),
      async accessSecretVersion(req, options) {
        calls.access.push(req.name);
        calls.accessOptions.push(options);
        if (accessResult instanceof Error) throw accessResult;
        return [{ payload: { data: Buffer.from(JSON.stringify({ username: "u" })) } }];
      },
    };
  }

  it("is true when versions/latest is readable", async () => {
    activeClient = makeExistsClient(null);

    assert.equal(await new SecretsManagerService().credentialsExist(KEY), true);
    assert.deepEqual(activeClient.calls.access, [LATEST]);
    assert.deepEqual(
      activeClient.calls.accessOptions,
      [ACCESS_CALL_OPTIONS],
      "with the client library's own retry turned off",
    );
    assert.equal(activeClient.calls.list.length, 0, "never lists");
  });

  it("is false when the secret does not exist (NOT_FOUND)", async () => {
    activeClient = makeExistsClient(notFound());

    assert.equal(await new SecretsManagerService().credentialsExist(KEY), false);
    assert.equal(activeClient.calls.list.length, 0);
  });

  it("is false when the newest version is destroyed or disabled (FAILED_PRECONDITION)", async () => {
    activeClient = makeExistsClient(failedPrecondition());

    assert.equal(await new SecretsManagerService().credentialsExist(KEY), false);
    assert.equal(activeClient.calls.list.length, 0);
  });

  it("throws a fixed message on any other error, with no resource name in it", async () => {
    activeClient = makeExistsClient(grpcError(7, `PERMISSION_DENIED on ${LATEST}`));

    await assert.rejects(
      () => new SecretsManagerService().credentialsExist(KEY),
      (err) => {
        assert.equal(err.message, "Failed to check credentials existence");
        return true;
      },
    );
    assert.equal(activeClient.calls.access.length, 1, "PERMISSION_DENIED is not retried");
  });
});

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
 *
 * @param opts.payload      object stored as JSON (undefined → no payload)
 * @param opts.accessError  error accessSecretVersion rejects with instead
 */
function makeReadClient({ payload, accessError } = {}) {
  const calls = { add: [], access: [], accessOptions: [], list: [] };
  let stored = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), "utf8");
  return {
    calls,
    listSecretVersions: listTripwire(calls),
    async addSecretVersion(req) {
      calls.add.push(req);
      stored = req.payload.data;
      return [{ name: V(1) }];
    },
    async createSecret() {
      return [{ name: SECRET }];
    },
    async accessSecretVersion(req, options) {
      calls.access.push(req.name);
      calls.accessOptions.push(options);
      if (accessError) throw accessError;
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

describe("SecretsManagerService.getCredentials — reads versions/latest (NEO-385)", () => {
  it("addresses versions/latest directly and never lists", async () => {
    activeClient = makeReadClient({ payload: { username: "seller@example.com" } });

    await new SecretsManagerService().getCredentials(KEY);

    assert.deepEqual(activeClient.calls.access, [LATEST], "one access, of the latest version");
    assert.equal(activeClient.calls.list.length, 0, "ListSecretVersions is never called on a read");
  });

  it("passes ACCESS_CALL_OPTIONS, turning off the client library's own retry", async () => {
    // The client's default config retries AccessSecretVersion on
    // RESOURCE_EXHAUSTED / UNAVAILABLE for up to 10 minutes, which would hold
    // a token request open far past any caller's timeout. withQuotaRetry is
    // meant to be the ONLY retry layer, and it is bounded.
    activeClient = makeReadClient({ payload: { username: "seller@example.com" } });

    await new SecretsManagerService().getCredentials(KEY);

    assert.deepEqual(ACCESS_CALL_OPTIONS, { retry: null, timeout: 5_000 }, "the options themselves");
    assert.equal(activeClient.calls.accessOptions.length, 1);
    assert.equal(
      activeClient.calls.accessOptions[0],
      ACCESS_CALL_OPTIONS,
      "the read hands the client exactly these options",
    );
  });

  it("reports NOT_FOUND as 'Credentials not found'", async () => {
    activeClient = makeReadClient({ accessError: notFound() });

    await assert.rejects(
      () => new SecretsManagerService().getCredentials(KEY),
      (err) => {
        assert.equal(err.message, "Credentials not found");
        return true;
      },
    );
    assert.equal(activeClient.calls.access.length, 1, "NOT_FOUND is an answer, not retried");
  });

  it("reports a destroyed/disabled latest version (FAILED_PRECONDITION) as 'No active version'", async () => {
    // The routes match on this substring (routes/credentials.ts,
    // routes/easypost.ts) to answer 404 — not on the key, which NEO-294
    // removed.
    activeClient = makeReadClient({ accessError: failedPrecondition() });

    await assert.rejects(
      () => new SecretsManagerService().getCredentials(KEY),
      (err) => {
        assert.equal(err.message, "No active version found");
        assert.ok(
          !err.message.includes(KEY) && !err.message.includes("user_abc"),
          "the per-user key must not ride out on the thrown message",
        );
        return true;
      },
    );
    assert.equal(activeClient.calls.access.length, 1, "FAILED_PRECONDITION is an answer, not retried");
  });

  it("reports any other access failure as the generic message", async () => {
    activeClient = makeReadClient({ accessError: grpcError(7, `PERMISSION_DENIED on ${LATEST}`) });

    await assert.rejects(
      () => new SecretsManagerService().getCredentials(KEY),
      /^Error: Failed to retrieve credentials$/,
    );
  });

  it("reports an empty payload as the generic message", async () => {
    activeClient = makeReadClient({});

    await assert.rejects(
      () => new SecretsManagerService().getCredentials(KEY),
      /^Error: Failed to retrieve credentials$/,
    );
  });
});

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
      { name: "gRPC NOT_FOUND", client: () => makeReadClient({ accessError: notFound() }) },
      {
        name: "latest version destroyed (FAILED_PRECONDITION)",
        client: () => makeReadClient({ accessError: failedPrecondition() }),
      },
      {
        name: "unparseable payload",
        client: () => {
          const c = makeReadClient({ payload: {} });
          c._setRaw("{not-json");
          return c;
        },
      },
    ];

    for (const { name, client } of cases) {
      activeClient = client();
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
    // NEO-294: keep the ordinal (it tells one version from another and is
    // what makes a prune failure chaseable), drop the project. The rest of
    // the resource name is `projects/<project>/secrets/<per-user-id>`, i.e.
    // the GCP project identifier this ticket keeps out of the error path.
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
    // Pinned across EVERY prune log line at once rather than one test per
    // branch — a new prune log that reaches for `secretName` fails here even
    // if it invents its own message. Timers are mocked so the quota case can
    // run its whole backoff without real waiting.
    mock.timers.enable({ apis: ["setTimeout"] });
    const cases = [
      {
        name: "created version name unavailable",
        client: () => makeClient({ createdVersion: null }),
      },
      {
        name: "created version name has no parseable ordinal",
        client: () => makeClient({ createdVersion: SECRET }),
      },
      {
        name: "destroy fails",
        client: () =>
          makeClient({
            createdVersion: V(3),
            destroyBehavior: () => {
              throw grpcError(7, "PERMISSION_DENIED: no destroy permission");
            },
          }),
      },
      {
        name: "destroy refused on quota on every attempt",
        client: () =>
          makeClient({
            createdVersion: V(3),
            destroyBehavior: () => {
              throw quotaExhausted();
            },
          }),
      },
    ];

    for (const { name, client } of cases) {
      capturedErrors = [];
      capturedLogs = [];
      capturedWarns = [];
      activeClient = client();

      await throughBackoff(new SecretsManagerService().updateCredentials(KEY, CREDS));

      const joined = [...capturedErrors, ...capturedLogs, ...capturedWarns].join("\n");
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

// ---------------------------------------------------------------------------
// NEO-385: RESOURCE_EXHAUSTED is retried, and only RESOURCE_EXHAUSTED
// ---------------------------------------------------------------------------
//
// A refused call is not executed, so retrying it is safe even for a write.
// The budget is two retries (400 ms, then 1200 ms, each jittered to
// 0.5x-1.5x so a herd of refused callers does not retry in lockstep): enough
// to ride out a per-minute quota edge without blowing the 7 s UX budget. Anything else is
// an answer (NOT_FOUND, FAILED_PRECONDITION) or a fault a retry will not fix,
// and must propagate on the first attempt.

describe("withQuotaRetry (NEO-385)", () => {
  it("returns the first success without waiting", async () => {
    let calls = 0;
    const result = await withQuotaRetry(async () => {
      calls++;
      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(calls, 1);
    assert.equal(capturedWarns.length, 0);
  });

  it("retries RESOURCE_EXHAUSTED after 400 ms, then 1200 ms, then rethrows", async () => {
    // Math.random() = 0.5 puts the jitter factor at exactly 1.0, so the
    // schedule under test is the un-jittered base.
    mock.method(Math, "random", () => 0.5);
    mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const err = quotaExhausted();
    const promise = withQuotaRetry(async () => {
      calls++;
      throw err;
    });
    promise.catch(() => {});

    await settle();
    assert.equal(calls, 1, "first attempt is immediate");
    mock.timers.tick(399);
    await settle();
    assert.equal(calls, 1, "the first retry waits the full 400 ms");
    mock.timers.tick(1);
    await settle();
    assert.equal(calls, 2, "first retry at 400 ms");
    mock.timers.tick(1199);
    await settle();
    assert.equal(calls, 2, "the second retry waits the full 1200 ms");
    mock.timers.tick(1);
    await settle();
    assert.equal(calls, 3, "second retry at 1200 ms");

    await assert.rejects(promise, (thrown) => thrown === err, "the last error propagates unchanged");
    mock.timers.tick(10_000);
    await settle();
    assert.equal(calls, 3, "at most 3 attempts — no third retry");

    const warns = capturedWarns.map((line) => JSON.parse(line));
    assert.deepEqual(warns, [
      { msg: "secret_manager_quota_retry", attempt: 1, delayMs: 400 },
      { msg: "secret_manager_quota_retry", attempt: 2, delayMs: 1200 },
    ]);
  });

  for (const [label, random, expected] of [
    ["low", 0, [200, 600]],
    ["high", 0.9999999, [600, 1800]],
  ]) {
    it(`jitters each delay within 0.5x-1.5x of its base (${label} end)`, async () => {
      // A herd of refused callers must not retry in lockstep, and the jitter
      // must stay inside the bounds that keep the total under ~2.4 s.
      mock.method(Math, "random", () => random);
      mock.timers.enable({ apis: ["setTimeout"] });
      let calls = 0;
      const promise = withQuotaRetry(async () => {
        calls++;
        throw quotaExhausted();
      });
      promise.catch(() => {});

      await settle();
      mock.timers.tick(expected[0] - 1);
      await settle();
      assert.equal(calls, 1, `first retry not before ${expected[0]} ms`);
      mock.timers.tick(1);
      await settle();
      assert.equal(calls, 2, `first retry at ${expected[0]} ms`);
      mock.timers.tick(expected[1] - 1);
      await settle();
      assert.equal(calls, 2, `second retry not before ${expected[1]} ms`);
      mock.timers.tick(1);
      await settle();
      assert.equal(calls, 3, `second retry at ${expected[1]} ms`);
      await assert.rejects(promise);

      assert.deepEqual(
        capturedWarns.map((line) => JSON.parse(line).delayMs),
        expected,
        "the retry log reports the jittered delay actually waited",
      );
    });
  }

  it("returns the value when a retry succeeds", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const result = await throughBackoff(
      withQuotaRetry(async () => {
        if (++calls === 1) throw quotaExhausted();
        return "second time lucky";
      }),
    );

    assert.equal(result, "second time lucky");
    assert.equal(calls, 2);
    assert.equal(capturedWarns.length, 1);
  });

  for (const [label, makeErr] of [
    ["NOT_FOUND (5)", notFound],
    ["FAILED_PRECONDITION (9)", failedPrecondition],
    ["PERMISSION_DENIED (7)", () => grpcError(7, "PERMISSION_DENIED")],
    ["an error with no code", () => new Error("socket hang up")],
  ]) {
    it(`does not retry ${label}`, async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      let calls = 0;
      const err = makeErr();
      await assert.rejects(
        withQuotaRetry(async () => {
          calls++;
          throw err;
        }),
        (thrown) => thrown === err,
      );

      assert.equal(calls, 1);
      assert.equal(capturedWarns.length, 0, "no retry, so no retry log");
    });
  }

  it("the retry log carries no resource name and no error message", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    await throughBackoff(
      withQuotaRetry(async () => {
        throw grpcError(8, `8 RESOURCE_EXHAUSTED on ${LATEST}`);
      }),
    ).catch(() => {});

    const joined = capturedWarns.join("\n");
    assert.equal(capturedWarns.length, 2);
    assert.ok(!joined.includes("projects/"), "no resource name");
    assert.ok(!joined.includes("RESOURCE_EXHAUSTED"), "no raw message");
  });
});

describe("SecretsManagerService — quota retry is wired into every call (NEO-385)", () => {
  it("getCredentials returns the credentials when the first read is refused on quota", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const client = makeReadClient({ payload: { username: "seller@example.com", token: "placeholder-token" } });
    let refused = false;
    const access = client.accessSecretVersion.bind(client);
    client.accessSecretVersion = async (req) => {
      if (!refused) {
        refused = true;
        client.calls.access.push(req.name);
        throw quotaExhausted();
      }
      return access(req);
    };
    activeClient = client;

    const creds = await throughBackoff(new SecretsManagerService().getCredentials(KEY));

    assert.deepEqual(creds, { username: "seller@example.com", token: "placeholder-token" });
    assert.deepEqual(client.calls.access, [LATEST, LATEST], "the retry re-reads versions/latest");
    assert.equal(client.calls.list.length, 0);
    assert.equal(capturedErrors.length, 0, "a recovered read is not an error");
  });

  it("getCredentials gives up after the retry budget with the generic message", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    activeClient = makeReadClient({ accessError: quotaExhausted() });

    await assert.rejects(
      throughBackoff(new SecretsManagerService().getCredentials(KEY)),
      /^Error: Failed to retrieve credentials$/,
    );
    assert.equal(activeClient.calls.access.length, 3, "1 attempt + 2 retries");
  });

  it("credentialsExist retries a quota refusal rather than reporting absence", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls = { list: [], access: [] };
    activeClient = {
      calls,
      listSecretVersions: listTripwire(calls),
      async accessSecretVersion(req) {
        calls.access.push(req.name);
        if (calls.access.length === 1) throw quotaExhausted();
        return [{ payload: { data: Buffer.from("{}") } }];
      },
    };

    assert.equal(await throughBackoff(new SecretsManagerService().credentialsExist(KEY)), true);
    assert.equal(calls.access.length, 2);
  });

  it("credentialsExist rejects, never reports absence, when every access is refused on quota", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    activeClient = makeReadClient({ accessError: quotaExhausted() });

    await assert.rejects(
      throughBackoff(new SecretsManagerService().credentialsExist(KEY)),
      /^Error: Failed to check credentials existence$/,
    );
    assert.equal(activeClient.calls.access.length, 3, "1 attempt + 2 retries");
  });

  it("updateCredentials retries a quota-refused add and still destroys N-1", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    activeClient = makeClient({ addBehavior: "quotaOnce", createdVersion: V(6) });

    await throughBackoff(new SecretsManagerService().updateCredentials(KEY, CREDS));

    assert.equal(activeClient.calls.add.length, 2, "the refused add was retried once");
    assert.equal(activeClient.calls.create.length, 0, "a quota refusal is not NOT_FOUND: no create");
    assert.deepEqual(destroyed(activeClient), [V(5)]);
  });

  it("updateCredentials surfaces the generic error when every add is refused on quota", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    activeClient = makeClient();
    activeClient.addSecretVersion = async (req) => {
      activeClient.calls.add.push(req);
      throw quotaExhausted();
    };

    await assert.rejects(
      throughBackoff(new SecretsManagerService().updateCredentials(KEY, CREDS)),
      /^Error: Failed to update credentials$/,
    );
    assert.equal(activeClient.calls.add.length, 3);
    assert.deepEqual(destroyed(activeClient), [], "a failed write must not prune");
  });

  it("the prune retries a quota-refused destroy of N-1", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    activeClient = makeClient({
      createdVersion: V(6),
      destroyBehavior: (_name, attempt) => {
        if (attempt === 1) throw quotaExhausted();
      },
    });

    await throughBackoff(new SecretsManagerService().updateCredentials(KEY, CREDS));

    assert.deepEqual(destroyed(activeClient), [V(5), V(5)], "same target, retried once");
    assert.equal(capturedErrors.length, 0, "a recovered destroy is not a failure");
  });

  it("the prune gives up quietly after the retry budget: 3 destroys of N-1, the write still succeeds", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    activeClient = makeClient({
      createdVersion: V(6),
      destroyBehavior: () => {
        throw quotaExhausted();
      },
    });

    await throughBackoff(new SecretsManagerService().updateCredentials(KEY, CREDS));

    assert.deepEqual(destroyed(activeClient), [V(5), V(5), V(5)]);
    const failures = capturedErrors.filter((line) => line.includes("Failed to destroy"));
    assert.equal(failures.length, 1, "one failure line for the abandoned prune");
  });
});

describe("SecretsManagerService — error logs carry the gRPC code, never the message (NEO-388)", () => {
  // A real GCP error message quotes the full resource name, project included.
  const leaky = () => grpcError(7, `7 PERMISSION_DENIED: Permission denied on resource ${V(3)}`);

  const cases = [
    {
      name: "getCredentials",
      line: "Failed to retrieve credentials",
      run: () => {
        activeClient = makeReadClient({ accessError: leaky() });
        return new SecretsManagerService().getCredentials(KEY);
      },
    },
    {
      name: "credentialsExist",
      line: "Failed to check credentials existence",
      run: () => {
        activeClient = makeReadClient({ accessError: leaky() });
        return new SecretsManagerService().credentialsExist(KEY);
      },
    },
    {
      name: "updateCredentials",
      line: "Failed to update credentials",
      run: () => {
        activeClient = makeClient();
        activeClient.addSecretVersion = async () => {
          throw leaky();
        };
        return new SecretsManagerService().updateCredentials(KEY, CREDS);
      },
    },
    {
      name: "deleteCredentials",
      line: "Failed to delete credentials",
      run: () => {
        activeClient = makeClient();
        activeClient.deleteSecret = async () => {
          throw leaky();
        };
        return new SecretsManagerService().deleteCredentials(KEY);
      },
    },
    {
      name: "the N-1 prune",
      line: "Failed to destroy",
      run: () => {
        activeClient = makeClient({
          createdVersion: V(4),
          destroyBehavior: () => {
            throw leaky();
          },
        });
        return new SecretsManagerService().updateCredentials(KEY, CREDS);
      },
    },
  ];

  for (const { name, line, run } of cases) {
    it(`${name} logs the code and not the resource name`, async () => {
      await run().catch(() => {});
      const failures = capturedErrors.filter((l) => l.includes(line));
      assert.equal(failures.length, 1, `${name}: one failure line`);
      assert.ok(failures[0].includes("gRPC code 7"), `${name}: the code is logged`);
      assert.ok(!failures[0].includes("projects/"), `${name}: never the resource name`);
      assert.ok(!failures[0].includes("PERMISSION_DENIED"), `${name}: never the raw message`);
    });
  }

  it("an error with no code is logged by its class name only", async () => {
    activeClient = makeReadClient({
      accessError: new TypeError(`fetch failed for ${LATEST}`),
    });
    await new SecretsManagerService().getCredentials(KEY).catch(() => {});
    const failure = capturedErrors.find((l) => l.includes("Failed to retrieve credentials"));
    assert.ok(failure.includes("TypeError"));
    assert.ok(!failure.includes("projects/") && !failure.includes("fetch failed"));
  });
});
