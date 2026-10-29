/**
 * Unit tests for src/services/sportlots-automated-access.ts (NEO-288) — the
 * reader for the SportLots "Automated Access" keyId/secret pair.
 *
 * The contract under test:
 *   - one access of `versions/latest` against the fixed secret name in the
 *     configured project, with ACCESS_CALL_OPTIONS (the client library's own
 *     retry off) — never a ListSecretVersions (NEO-385: metered at 600/min
 *     per project, and parallel E2E runs exhausted it).
 *   - NOT_FOUND / FAILED_PRECONDITION on that access mean "nothing stored";
 *     RESOURCE_EXHAUSTED is retried through withQuotaRetry.
 *   - The payload is untrusted: narrowed field by field, both fields must be
 *     non-empty strings, nothing else is copied.
 *   - EVERY failure (no version, empty payload, junk JSON, a missing/empty
 *     field, a thrown client) surfaces as the ONE fixed error and nothing
 *     from the payload or the client error rides along.
 *   - A successful read is cached (~10 min); invalidate forces a re-read.
 *   - Importing the module never constructs the client; the first READ does.
 *
 * Strategy: replace `@google-cloud/secret-manager` in the CJS require cache
 * with a fake whose constructor hands back a per-test spy (mirrors
 * tests/secrets-manager.test.mjs), THEN load the compiled dist. No real GCP
 * client is ever constructed, so the tests need no ADC.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let activeClient = null;
let constructed = 0;

class FakeSecretManagerServiceClient {
  constructor() {
    constructed++;
    // The module constructs ONE client on its first read and keeps it for the
    // life of the process (production behaviour). Returning a delegating
    // object from the constructor replaces `this`, and delegating at CALL
    // time lets each test swap in its own spy via `activeClient`.
    return {
      // Delegated even though the reader must never call it, so a regression
      // that reintroduces a list lands on the per-test tripwire.
      listSecretVersions: (req) => activeClient.listSecretVersions(req),
      accessSecretVersion: (req, options) => activeClient.accessSecretVersion(req, options),
    };
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

const modPath = require.resolve("../dist/services/sportlots-automated-access");
delete require.cache[modPath];
const mod = require(modPath);
const { ACCESS_CALL_OPTIONS } = require("../dist/services/secrets-manager");
const {
  getAutomatedAccessCredential,
  invalidateAutomatedAccessCredential,
  SPORTLOTS_AUTOMATED_ACCESS_SECRET,
  AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR,
} = mod;

const SECRET_NAME = `projects/neonbinder-test/secrets/${SPORTLOTS_AUTOMATED_ACCESS_SECRET}`;
const LATEST = `${SECRET_NAME}/versions/latest`;

// Placeholders, never real values. The "never echoed" assertions grep for
// exactly these.
const KEY_ID = "KEYID-PLACEHOLDER-0001";
const SECRET = "SECRET-PLACEHOLDER-0002";

/** An error shaped like the client's: a gRPC status on `code`. */
function grpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Build a spy client.
 *
 * @param opts.payload       the string accessSecretVersion returns (null → no payload)
 * @param opts.accessThrows  reject accessSecretVersion with this error
 */
function makeClient({ payload = "", accessThrows = null } = {}) {
  const calls = { list: [], access: [], accessOptions: [] };
  return {
    calls,
    async listSecretVersions(req) {
      calls.list.push(req);
      throw new Error("listSecretVersions must never be called (NEO-385)");
    },
    async accessSecretVersion(req, options) {
      calls.access.push(req);
      calls.accessOptions.push(options);
      if (accessThrows) throw accessThrows;
      if (payload === null) return [{}];
      return [{ payload: { data: Buffer.from(payload) } }];
    },
  };
}

/** Let every pending promise continuation run (setImmediate is not mocked). */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Run `fn` with console.log/console.error/console.warn captured. Always restores. */
async function captureConsole(fn) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  const realWarn = console.warn;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  console.error = (...args) => lines.push(args.map(String).join(" "));
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
    console.warn = realWarn;
  }
  return lines.join("\n");
}

describe("getAutomatedAccessCredential (NEO-288)", () => {
  beforeEach(() => {
    // Every test starts cold (no cached value); the spy is swapped per test.
    invalidateAutomatedAccessCredential();
  });

  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("importing the module constructed NO client; the first read does", async () => {
    assert.equal(constructed, 0, "import must not touch GCP");
    activeClient = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET }) });
    await getAutomatedAccessCredential();
    assert.equal(constructed, 1);
  });

  it("reads versions/latest of the fixed secret name, and never lists (NEO-385)", async () => {
    const client = makeClient({
      payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET, extra: "ignored" }),
    });
    activeClient = client;
    const cred = await getAutomatedAccessCredential();
    assert.deepEqual(cred, { keyId: KEY_ID, secret: SECRET }, "narrowed to exactly the two fields");
    assert.deepEqual(client.calls.access, [{ name: LATEST }], "one access, of the latest version");
    assert.equal(client.calls.list.length, 0, "ListSecretVersions is never called");
    assert.equal(
      client.calls.accessOptions[0],
      ACCESS_CALL_OPTIONS,
      "the client library's own (10-minute) retry is turned off",
    );
  });

  it("caches a successful read: a second call does not touch Secret Manager", async () => {
    const client = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET }) });
    activeClient = client;
    const a = await getAutomatedAccessCredential();
    const b = await getAutomatedAccessCredential();
    assert.deepEqual(a, b);
    assert.equal(client.calls.access.length, 1, "one access");
  });

  it("invalidate forces a re-read, which picks up a rotated value", async () => {
    const first = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET }) });
    activeClient = first;
    assert.equal((await getAutomatedAccessCredential()).secret, SECRET);

    const rotated = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: "SECRET-PLACEHOLDER-ROTATED" }) });
    activeClient = rotated;
    // Still cached: the rotated client is not consulted.
    assert.equal((await getAutomatedAccessCredential()).secret, SECRET);
    assert.equal(rotated.calls.access.length, 0);

    invalidateAutomatedAccessCredential();
    assert.equal((await getAutomatedAccessCredential()).secret, "SECRET-PLACEHOLDER-ROTATED");
    assert.equal(rotated.calls.access.length, 1);
  });

  it("a failed read is NOT cached: the next call reads again", async () => {
    const bad = makeClient({ payload: "{" });
    activeClient = bad;
    await assert.rejects(getAutomatedAccessCredential(), { message: AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR });
    const good = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET }) });
    activeClient = good;
    assert.equal((await getAutomatedAccessCredential()).keyId, KEY_ID);
    assert.equal(good.calls.access.length, 1);
  });

  it("every malformed payload → the ONE fixed error", async () => {
    for (const payload of [
      JSON.stringify({ keyId: KEY_ID }), // missing secret
      JSON.stringify({ secret: SECRET }), // missing keyId
      JSON.stringify({ keyId: "", secret: SECRET }), // empty keyId
      JSON.stringify({ keyId: KEY_ID, secret: "" }), // empty secret
      JSON.stringify({ keyId: 42, secret: SECRET }), // wrong type
      JSON.stringify({ keyId: KEY_ID, secret: { v: SECRET } }), // wrong type
      JSON.stringify([KEY_ID, SECRET]), // array
      JSON.stringify("just a string"),
      "null",
      "",
      "not json at all",
      `{"keyId":"${KEY_ID}","secret":"${SECRET}"`, // truncated JSON
    ]) {
      invalidateAutomatedAccessCredential();
      activeClient = makeClient({ payload });
      await assert.rejects(
        getAutomatedAccessCredential(),
        (err) => err instanceof Error && err.message === AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR,
        `payload ${JSON.stringify(payload)} must surface the fixed error`,
      );
    }
  });

  it("no secret, a destroyed/disabled latest version, or no payload → the fixed error", async () => {
    for (const client of [
      makeClient({ accessThrows: grpcError(5, `5 NOT_FOUND: Secret [${SECRET_NAME}] not found.`) }),
      makeClient({ accessThrows: grpcError(9, `9 FAILED_PRECONDITION: ${LATEST} is in DESTROYED state.`) }),
      makeClient({ payload: null }),
    ]) {
      invalidateAutomatedAccessCredential();
      activeClient = client;
      let caught;
      const logged = await captureConsole(async () => {
        try {
          await getAutomatedAccessCredential();
        } catch (e) {
          caught = e;
        }
      });
      assert.equal(caught?.message, AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR);
      // These are "nothing stored", not client faults: answered on the first
      // attempt, and not logged as a failed read.
      assert.equal(client.calls.access.length, 1, "NOT_FOUND / FAILED_PRECONDITION are not retried");
      assert.ok(!logged.includes("credential read failed"));
      assert.equal(client.calls.list.length, 0);
    }
  });

  it("a quota-refused read is retried and then succeeds", async () => {
    mock.method(Math, "random", () => 0.5); // jitter factor 1.0: delays are 400 / 1200
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(console, "warn", () => {}); // the expected retry log lines
    const refusals = [grpcError(8, "8 RESOURCE_EXHAUSTED: Quota exceeded")];
    const client = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET }) });
    const access = client.accessSecretVersion.bind(client);
    client.accessSecretVersion = async (req, options) => {
      if (refusals.length) {
        client.calls.access.push(req);
        throw refusals.shift();
      }
      return access(req, options);
    };
    activeClient = client;

    const promise = getAutomatedAccessCredential();
    promise.catch(() => {});
    await settle();
    mock.timers.tick(400);
    await settle();

    assert.deepEqual(await promise, { keyId: KEY_ID, secret: SECRET });
    assert.deepEqual(client.calls.access, [{ name: LATEST }, { name: LATEST }]);
  });

  it("a read refused on quota past the retry budget → the fixed error, 3 attempts", async () => {
    mock.method(Math, "random", () => 0.5);
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(console, "warn", () => {}); // the expected retry log lines
    const client = makeClient({ accessThrows: grpcError(8, "8 RESOURCE_EXHAUSTED: Quota exceeded") });
    activeClient = client;

    const promise = getAutomatedAccessCredential();
    promise.catch(() => {});
    for (const ms of [400, 1200]) {
      await settle();
      mock.timers.tick(ms);
    }
    await settle();

    await assert.rejects(promise, { message: AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR });
    assert.equal(client.calls.access.length, 3, "1 attempt + 2 retries");
  });

  it("a thrown client → the fixed error; the client's message never escapes", async () => {
    // A client-library error can quote its request (the resource name is
    // benign, but the rule is: nothing from below rides into the response).
    const boom = new Error(`PERMISSION_DENIED: caller lacks secretmanager.versions.access on ${SECRET_NAME} payload=${SECRET}`);
    boom.code = 7;
    for (const client of [makeClient({ accessThrows: boom })]) {
      invalidateAutomatedAccessCredential();
      activeClient = client;
      let caught;
      const logged = await captureConsole(async () => {
        try {
          await getAutomatedAccessCredential();
        } catch (e) {
          caught = e;
        }
      });
      assert.ok(caught instanceof Error);
      assert.equal(caught.message, AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR);
      assert.ok(!caught.message.includes("PERMISSION_DENIED"));
      assert.ok(!logged.includes(SECRET), "the client error's message is never logged, only its name");
      assert.ok(!logged.includes("PERMISSION_DENIED"));
      assert.ok(logged.includes("credential read failed: Error"), "the error NAME is logged for triage");
    }
  });

  it("SECURITY: a JSON parse failure never echoes the payload (SyntaxError.message quotes the input)", async () => {
    // Node >= 20: `JSON.parse('{"secret":"…"') → SyntaxError: Expected ',' or
    // '}' after property value in JSON at position N (line 1 column M)` and
    // some builds include a window of the input. Whatever the runtime does,
    // nothing from the payload may reach the thrown error or the console.
    const payload = `{"keyId":"${KEY_ID}","secret":"${SECRET}"`; // truncated
    activeClient = makeClient({ payload });
    let caught;
    const logged = await captureConsole(async () => {
      try {
        await getAutomatedAccessCredential();
      } catch (e) {
        caught = e;
      }
    });
    assert.equal(caught.message, AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR);
    assert.ok(!caught.message.includes(SECRET));
    assert.ok(!caught.message.includes(KEY_ID));
    assert.ok(!(caught instanceof SyntaxError), "the SyntaxError itself is never re-thrown");
    assert.equal(caught.cause, undefined, "nor attached as a cause");
    assert.ok(!logged.includes(SECRET) && !logged.includes(KEY_ID), "nor logged");
    assert.ok(!logged.includes("SyntaxError"));
  });

  it("concurrent cold reads: neither throws, and the cache ends up holding a non-stale value", async () => {
    // Two callers both see an empty cache and both kick off a real read — the
    // documented "acceptable double read". Neither may throw, and the value
    // left in the cache afterwards must be a value ONE of the two reads
    // actually returned (never a partial/corrupt merge, never undefined).
    let accessCalls = 0;
    activeClient = {
      async accessSecretVersion() {
        accessCalls++;
        const myCall = accessCalls;
        if (myCall === 1) await new Promise((r) => setTimeout(r, 20));
        const payload = myCall === 1
          ? JSON.stringify({ keyId: KEY_ID, secret: SECRET })
          : JSON.stringify({ keyId: "concurrent-key", secret: "concurrent-secret" });
        return [{ payload: { data: Buffer.from(payload) } }];
      },
    };
    const [a, b] = await Promise.all([
      getAutomatedAccessCredential(),
      getAutomatedAccessCredential(),
    ]);
    for (const cred of [a, b]) {
      assert.ok(
        (cred.keyId === KEY_ID && cred.secret === SECRET) ||
          (cred.keyId === "concurrent-key" && cred.secret === "concurrent-secret"),
        "each caller gets a coherent, non-corrupt credential",
      );
    }
    const finalRead = await getAutomatedAccessCredential();
    assert.ok(
      (finalRead.keyId === KEY_ID && finalRead.secret === SECRET) ||
        (finalRead.keyId === "concurrent-key" && finalRead.secret === "concurrent-secret"),
      "the cache holds a real value from one of the two reads, not a merge or corruption",
    );
  });

  it("REGRESSION: a slow read already in flight before invalidate() must not resurrect the discarded value", async () => {
    // The generation-counter fix. Sequence:
    //   1. A slow read (A) starts against a cold cache and stalls on
    //      accessSecretVersion.
    //   2. A fast read (B) starts and completes first, caching its value.
    //   3. invalidate() runs — e.g. the adapter just had this credential
    //      REFUSED by SportLots and wants the next read to hit Secret
    //      Manager again.
    //   4. A finally resolves and, before the fix, unconditionally wrote its
    //      (now-superseded) value back into the cache — silently undoing
    //      step 3 for every caller until another invalidate() happened to
    //      land. The fixed behaviour: A's write is discarded because the
    //      generation moved on while it was in flight.
    let accessCalls = 0;
    activeClient = {
      async accessSecretVersion() {
        accessCalls++;
        if (accessCalls === 1) {
          await new Promise((r) => setTimeout(r, 30));
          return [{ payload: { data: Buffer.from(JSON.stringify({ keyId: "old-key", secret: "old-secret" })) } }];
        }
        return [{ payload: { data: Buffer.from(JSON.stringify({ keyId: "new-key", secret: "new-secret" })) } }];
      },
    };

    const callA = getAutomatedAccessCredential(); // slow, will resolve to old-key
    await new Promise((r) => setTimeout(r, 5)); // let A's accessSecretVersion start
    const callB = await getAutomatedAccessCredential(); // fast, resolves to new-key
    assert.equal(callB.keyId, "new-key");

    invalidateAutomatedAccessCredential();

    const resultA = await callA;
    assert.equal(resultA.keyId, "old-key", "A still returns whatever IT fetched");

    const finalRead = await getAutomatedAccessCredential();
    assert.notEqual(
      finalRead.keyId,
      "old-key",
      "A's late, stale write must not have repopulated the cache after invalidate()",
    );
    // A fresh read went back to Secret Manager (cache was empty after
    // invalidate(), and A's write was discarded) rather than serving A's
    // stale value or an empty/thrown result.
    assert.equal(finalRead.keyId, "new-key");
  });

  it("the fixed error contains 'automated access' so the route classifies it as automated_access", () => {
    const { classifyBrowserError, loginFailureOutcome } = require("../dist/observability");
    assert.equal(classifyBrowserError(AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR), "automated_access");
    assert.equal(loginFailureOutcome({}, AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR).status, 502, "pages");
  });

  it("the secret name is the documented one", () => {
    assert.equal(SPORTLOTS_AUTOMATED_ACCESS_SECRET, "sportlots-automated-access");
  });
});
