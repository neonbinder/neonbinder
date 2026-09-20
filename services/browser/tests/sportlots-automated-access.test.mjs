/**
 * Unit tests for src/services/sportlots-automated-access.ts (NEO-288) — the
 * reader for the SportLots "Automated Access" keyId/secret pair.
 *
 * The contract under test:
 *   - list → first ENABLED → access, against the fixed secret name in the
 *     configured project.
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

import { describe, it, beforeEach } from "node:test";
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
      listSecretVersions: (req) => activeClient.listSecretVersions(req),
      accessSecretVersion: (req) => activeClient.accessSecretVersion(req),
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
const {
  getAutomatedAccessCredential,
  invalidateAutomatedAccessCredential,
  SPORTLOTS_AUTOMATED_ACCESS_SECRET,
  AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR,
} = mod;

const SECRET_NAME = `projects/neonbinder-test/secrets/${SPORTLOTS_AUTOMATED_ACCESS_SECRET}`;
const V = (n) => `${SECRET_NAME}/versions/${n}`;

// Placeholders, never real values. The "never echoed" assertions grep for
// exactly these.
const KEY_ID = "KEYID-PLACEHOLDER-0001";
const SECRET = "SECRET-PLACEHOLDER-0002";

/**
 * Build a spy client.
 *
 * @param opts.versions  what listSecretVersions returns
 * @param opts.payload   the string accessSecretVersion returns (null → no payload)
 * @param opts.listThrows / opts.accessThrows  reject the respective call
 */
function makeClient({ versions = [{ name: V(3), state: "ENABLED" }], payload = "", listThrows = null, accessThrows = null } = {}) {
  const calls = { list: [], access: [] };
  return {
    calls,
    async listSecretVersions(req) {
      calls.list.push(req);
      if (listThrows) throw listThrows;
      return [versions];
    },
    async accessSecretVersion(req) {
      calls.access.push(req);
      if (accessThrows) throw accessThrows;
      if (payload === null) return [{}];
      return [{ payload: { data: Buffer.from(payload) } }];
    },
  };
}

/** Run `fn` with console.log/console.error captured. Always restores. */
async function captureConsole(fn) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines.join("\n");
}

describe("getAutomatedAccessCredential (NEO-288)", () => {
  beforeEach(() => {
    // Every test starts cold (no cached value); the spy is swapped per test.
    invalidateAutomatedAccessCredential();
  });

  it("importing the module constructed NO client; the first read does", async () => {
    assert.equal(constructed, 0, "import must not touch GCP");
    activeClient = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET }) });
    await getAutomatedAccessCredential();
    assert.equal(constructed, 1);
  });

  it("reads list → first ENABLED → access against the fixed secret name", async () => {
    const client = makeClient({
      versions: [
        { name: V(9), state: "DESTROYED" },
        { name: V(8), state: "DISABLED" },
        { name: V(7), state: "ENABLED" },
        { name: V(6), state: "ENABLED" },
      ],
      payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET, extra: "ignored" }),
    });
    activeClient = client;
    const cred = await getAutomatedAccessCredential();
    assert.deepEqual(cred, { keyId: KEY_ID, secret: SECRET }, "narrowed to exactly the two fields");
    assert.deepEqual(client.calls.list, [{ parent: SECRET_NAME }]);
    assert.deepEqual(client.calls.access, [{ name: V(7) }], "the first ENABLED version, skipping destroyed/disabled");
  });

  it("caches a successful read: a second call does not touch Secret Manager", async () => {
    const client = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET }) });
    activeClient = client;
    const a = await getAutomatedAccessCredential();
    const b = await getAutomatedAccessCredential();
    assert.deepEqual(a, b);
    assert.equal(client.calls.list.length, 1, "one list");
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
    assert.equal(rotated.calls.list.length, 0);

    invalidateAutomatedAccessCredential();
    assert.equal((await getAutomatedAccessCredential()).secret, "SECRET-PLACEHOLDER-ROTATED");
    assert.equal(rotated.calls.list.length, 1);
  });

  it("a failed read is NOT cached: the next call reads again", async () => {
    const bad = makeClient({ payload: "{" });
    activeClient = bad;
    await assert.rejects(getAutomatedAccessCredential(), { message: AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR });
    const good = makeClient({ payload: JSON.stringify({ keyId: KEY_ID, secret: SECRET }) });
    activeClient = good;
    assert.equal((await getAutomatedAccessCredential()).keyId, KEY_ID);
    assert.equal(good.calls.list.length, 1);
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

  it("no ENABLED version, or no payload → the fixed error", async () => {
    for (const client of [
      makeClient({ versions: [] }),
      makeClient({ versions: [{ name: V(2), state: "DISABLED" }] }),
      makeClient({ versions: [{ state: "ENABLED" }] }), // no name
      makeClient({ payload: null }),
    ]) {
      invalidateAutomatedAccessCredential();
      activeClient = client;
      await assert.rejects(getAutomatedAccessCredential(), { message: AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR });
    }
  });

  it("a thrown client → the fixed error; the client's message never escapes", async () => {
    // A client-library error can quote its request (the resource name is
    // benign, but the rule is: nothing from below rides into the response).
    const boom = new Error(`PERMISSION_DENIED: caller lacks secretmanager.versions.access on ${SECRET_NAME} payload=${SECRET}`);
    boom.code = 7;
    for (const client of [makeClient({ listThrows: boom }), makeClient({ accessThrows: boom })]) {
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

  it("the fixed error contains 'automated access' so the route classifies it as automated_access", () => {
    const { classifyBrowserError, loginFailureOutcome } = require("../dist/observability");
    assert.equal(classifyBrowserError(AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR), "automated_access");
    assert.equal(loginFailureOutcome({}, AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR).status, 502, "pages");
  });

  it("the secret name is the documented one", () => {
    assert.equal(SPORTLOTS_AUTOMATED_ACCESS_SECRET, "sportlots-automated-access");
  });
});
