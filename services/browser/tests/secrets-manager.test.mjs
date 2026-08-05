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
 * Two properties in here are safety-critical and must never be relaxed:
 *
 *  1. The just-written version is NEVER destroyed, and exclusion is by the
 *     explicit resource name returned from addSecretVersion — never by "first
 *     in the list". List order is a race against a concurrent write from
 *     another Cloud Run instance; losing that race destroys a live credential.
 *  2. Pruning is best-effort. A destroy/list failure must not propagate out of
 *     updateCredentials — a user saving their marketplace password must not
 *     see an error because cleanup hiccuped, and the credential write has
 *     already succeeded by then.
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

  return {
    calls,
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
      if (destroyBehavior) destroyBehavior(req.name);
      return [{ name: req.name, state: "DESTROYED" }];
    },
  };
}

/** Names passed to destroySecretVersion, in call order. */
const destroyed = (client) => client.calls.destroy;

// Capture console.error so best-effort failures don't spam the test output —
// and so we can assert nothing secret leaks into them.
let capturedErrors = [];
const realError = console.error;

beforeEach(() => {
  capturedErrors = [];
  console.error = (...args) => capturedErrors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.error = realError;
  activeClient = null;
});

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

  it("never destroys the version it just wrote, even when a NEWER version exists", async () => {
    // Simulates a concurrent write from another Cloud Run instance landing as
    // version 9 while this call created version 8. Version 9 sorts first in
    // Secret Manager's newest-first list order — "keep the first one" would
    // destroy our own live credential. Exclusion is by name, so v8 survives.
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
    assert.deepEqual(destroyed(activeClient), [V(9), V(7)], "everything else is pruned (keep-1)");
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
});

// ---------------------------------------------------------------------------
// Security: nothing secret in the logs
// ---------------------------------------------------------------------------

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
