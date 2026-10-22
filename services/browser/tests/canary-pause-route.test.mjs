/**
 * Route wiring for the canary pause gate (NEO-355).
 *
 * src/index.ts calls app.listen() at import time, so the /login/<site> routes
 * cannot be driven in-process. The route's canary-pause behaviour therefore
 * lives in one helper, respondIfCanaryPaused (src/canary-pause.ts), and this
 * file covers it in two halves:
 *
 *   1. The helper itself, with a fake res and an injected gate, log and
 *      clock: what it sends, what it logs, and when it does neither.
 *   2. A source-order pin on src/index.ts: each login route calls the helper
 *      once, with its OWN platform slug, after the key and transient-
 *      credential checks and before it constructs its adapter. Deleting the
 *      call, moving it below `new …Adapter(`, or passing the other route's
 *      slug turns this red.
 *
 * The compiled CJS dist is imported via createRequire like the other tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { respondIfCanaryPaused, canaryGate } = require("../dist/canary-pause");

/** A res that records every json() body. */
function fakeRes() {
  const sent = [];
  return {
    sent,
    json(body) {
      sent.push(body);
      return this;
    },
  };
}

/** Injected deps: a gate answering `decision`, a recording log, a fixed clock. */
function deps(decision) {
  const gateCalls = [];
  const lines = [];
  return {
    gateCalls,
    lines,
    deps: {
      gate: async (input, gateDeps) => {
        gateCalls.push({ input, gateDeps });
        return decision;
      },
      log: (line) => lines.push(line),
      now: () => 1_250,
    },
  };
}

const START_MS = 1_000;

describe("respondIfCanaryPaused: a paused canary is answered without a sign-in", () => {
  for (const [platform, label] of [
    ["sportlots", "SportLots"],
    ["bsc", "BSC"],
  ]) {
    it(`${platform}: handled, exact 200 body, exactly one heartbeat line`, async () => {
      const res = fakeRes();
      const h = deps("skip_paused");
      const handled = await respondIfCanaryPaused(
        { canary: true, platform, startMs: START_MS },
        res,
        h.deps,
      );

      assert.equal(handled, true);
      assert.deepEqual(res.sent, [
        {
          success: true,
          skipped: "paused",
          message: `${label} is paused (NEONBINDER_PAUSED_PLATFORMS); canary sign-in skipped`,
        },
      ]);
      assert.deepEqual(h.lines, [
        {
          msg: "browser_login_call",
          operation: `login_${platform}`,
          platform,
          duration_ms: 250,
          success: true,
          status_code: 200,
          canary: true,
          outcome: "skipped_paused",
        },
      ]);
      // The gate was asked about THIS platform, as a canary.
      assert.equal(h.gateCalls.length, 1);
      assert.deepEqual(h.gateCalls[0].input, { canary: true, platform });
    });
  }

  it("the body and the line carry nothing beyond the fixed fields", async () => {
    const res = fakeRes();
    const h = deps("skip_paused");
    await respondIfCanaryPaused({ canary: true, platform: "bsc", startMs: START_MS }, res, h.deps);
    assert.deepEqual(Object.keys(res.sent[0]).sort(), ["message", "skipped", "success"]);
    assert.deepEqual(
      Object.keys(h.lines[0]).sort(),
      ["canary", "duration_ms", "msg", "operation", "outcome", "platform", "status_code", "success"],
    );
  });

  it("duration_ms is measured from the route's startMs with the real clock by default", async () => {
    const res = fakeRes();
    const lines = [];
    const startMs = Date.now() - 40;
    await respondIfCanaryPaused(
      { canary: true, platform: "sportlots", startMs },
      res,
      { gate: async () => "skip_paused", log: (l) => lines.push(l) },
    );
    assert.equal(lines.length, 1);
    assert.ok(lines[0].duration_ms >= 40, `duration_ms ${lines[0].duration_ms}`);
    assert.ok(lines[0].duration_ms < 10_000, `duration_ms ${lines[0].duration_ms}`);
  });

  it("forwards gateDeps to the gate", async () => {
    const res = fakeRes();
    const h = deps("skip_paused");
    const gateDeps = { siteUrl: "https://example-deployment.convex.site" };
    await respondIfCanaryPaused(
      { canary: true, platform: "bsc", startMs: START_MS },
      res,
      { ...h.deps, gateDeps },
    );
    assert.equal(h.gateCalls[0].gateDeps, gateDeps);
  });

  it("end to end with the real canaryGate and an injected lookup", async () => {
    const res = fakeRes();
    const lines = [];
    const seen = [];
    const handled = await respondIfCanaryPaused(
      { canary: true, platform: "sportlots", startMs: START_MS },
      res,
      {
        gateDeps: {
          shouldSkipCanary: async (platform) => {
            seen.push(platform);
            return true;
          },
        },
        log: (l) => lines.push(l),
        now: () => 1_010,
      },
    );
    assert.equal(handled, true);
    assert.deepEqual(seen, ["sportlots"]);
    assert.equal(res.sent.length, 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, "skipped_paused");
  });
});

describe("respondIfCanaryPaused: every other path sends and logs nothing", () => {
  it("proceed → not handled, nothing sent, nothing logged", async () => {
    for (const platform of ["sportlots", "bsc"]) {
      const res = fakeRes();
      const h = deps("proceed");
      const handled = await respondIfCanaryPaused(
        { canary: true, platform, startMs: START_MS },
        res,
        h.deps,
      );
      assert.equal(handled, false);
      assert.deepEqual(res.sent, []);
      assert.deepEqual(h.lines, []);
      assert.equal(h.gateCalls.length, 1);
    }
  });

  it("an unexpected gate answer is not a skip", async () => {
    for (const decision of [undefined, "skip", "SKIP_PAUSED", true]) {
      const res = fakeRes();
      const h = deps(decision);
      const handled = await respondIfCanaryPaused(
        { canary: true, platform: "bsc", startMs: START_MS },
        res,
        h.deps,
      );
      assert.equal(handled, false, String(decision));
      assert.deepEqual(res.sent, []);
      assert.deepEqual(h.lines, []);
    }
  });

  it("non-canary → the gate is never called, even if it would say skip", async () => {
    for (const canary of [false, undefined, null, "true", 1]) {
      const res = fakeRes();
      const h = deps("skip_paused");
      const handled = await respondIfCanaryPaused(
        { canary, platform: "bsc", startMs: START_MS },
        res,
        h.deps,
      );
      assert.equal(handled, false, String(canary));
      assert.equal(h.gateCalls.length, 0, String(canary));
      assert.deepEqual(res.sent, []);
      assert.deepEqual(h.lines, []);
    }
  });

  it("non-canary with the real gate → the lookup is never called", async () => {
    let lookups = 0;
    const res = fakeRes();
    const lines = [];
    const handled = await respondIfCanaryPaused(
      { canary: false, platform: "sportlots", startMs: START_MS },
      res,
      {
        gate: canaryGate,
        gateDeps: { shouldSkipCanary: async () => (lookups++, true) },
        log: (l) => lines.push(l),
      },
    );
    assert.equal(handled, false);
    assert.equal(lookups, 0);
    assert.deepEqual(res.sent, []);
    assert.deepEqual(lines, []);
  });

  it("a failing lookup through the real gate proceeds (fail-open), silently at the route", async () => {
    const res = fakeRes();
    const lines = [];
    const handled = await respondIfCanaryPaused(
      { canary: true, platform: "bsc", startMs: START_MS },
      res,
      {
        gateDeps: {
          shouldSkipCanary: async () => {
            throw new Error("boom");
          },
        },
        log: (l) => lines.push(l),
      },
    );
    assert.equal(handled, false);
    assert.deepEqual(res.sent, []);
    assert.deepEqual(lines, []);
  });
});

// ---------------------------------------------------------------------------
// Source-order pin on src/index.ts
// ---------------------------------------------------------------------------

const INDEX_SRC = readFileSync(
  fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  "utf8",
);

/** The text of one `app.post("<path>", …)` handler, up to the next route. */
function routeBody(src, path) {
  const marker = `app.post("${path}"`;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `route ${path} not found in src/index.ts`);
  assert.equal(src.indexOf(marker, start + 1), -1, `route ${path} registered twice`);
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\napp\.(post|get|put|patch|delete|use)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

const ROUTES = [
  { path: "/login/sportlots", platform: "sportlots", adapter: "SportlotsAdapter" },
  { path: "/login/bsc", platform: "bsc", adapter: "BSCAdapter" },
];

const CALL_RE =
  /if \(await respondIfCanaryPaused\(\{\s*canary,\s*platform:\s*"([a-z]+)",\s*startMs\s*\},\s*res\)\) return;/g;

describe("src/index.ts: each login route wires the canary pause check", () => {
  it("index.ts imports the helper and no longer calls canaryGate directly", () => {
    assert.match(INDEX_SRC, /import \{ respondIfCanaryPaused \} from "\.\/canary-pause";/);
    assert.doesNotMatch(INDEX_SRC, /\bcanaryGate\(/);
  });

  for (const { path, platform, adapter } of ROUTES) {
    it(`${path}: one call with platform "${platform}", after the input checks, before new ${adapter}(`, () => {
      const body = routeBody(INDEX_SRC, path);

      const calls = [...body.matchAll(CALL_RE)];
      assert.equal(calls.length, 1, `${path}: expected exactly one respondIfCanaryPaused call`);
      // Any other spelling of the call (a second one, a different shape) is
      // also a wiring change this pin should see.
      assert.equal(body.split("respondIfCanaryPaused(").length - 1, 1);
      const [call] = calls;
      assert.equal(call[1], platform, `${path} passes the wrong platform slug`);

      const callAt = call.index;
      const keyCheckAt = body.indexOf("if (!key)");
      const transientAt = body.indexOf("parseTransientCredentials(");
      const transientRejectAt = body.indexOf("if (!transient.ok)");
      const adapterAt = body.indexOf(`new ${adapter}(`);
      for (const [name, at] of [
        ["key check", keyCheckAt],
        ["parseTransientCredentials", transientAt],
        ["transient reject", transientRejectAt],
        [`new ${adapter}(`, adapterAt],
      ]) {
        assert.notEqual(at, -1, `${path}: ${name} not found`);
      }
      assert.ok(keyCheckAt < callAt, `${path}: pause check runs before the key check`);
      assert.ok(transientRejectAt < callAt, `${path}: pause check runs before the transient check`);
      assert.ok(callAt < adapterAt, `${path}: pause check runs after new ${adapter}(`);
    });
  }
});
