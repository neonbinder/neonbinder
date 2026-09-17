/**
 * NEO-287 — `isPaused` (tests/integration/_helpers.mjs), the login probes'
 * half of the pause switch.
 *
 * CI plumbs the `NEONBINDER_PAUSED_PLATFORMS` GitHub Actions repository
 * variable through to the probes as `PAUSED_PLATFORMS`, in the SAME
 * comma-separated site-key vocabulary Convex reads
 * (`convex/marketplacePause.ts`). The probes run against Cloud Run with no
 * Convex context at all, so this is a second, independent parser over the
 * same wire shape — pinned here so the two never silently disagree on what
 * "paused" means.
 *
 * Not run under tests/integration/ (the real-login prod gate) — this is the
 * pure helper, collected by the ordinary unit lane (`npm test` →
 * `tests/*.test.mjs`).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// `_helpers.mjs` is the integration prod-gate's shared module, and it reads
// `TARGET_URL` at MODULE SCOPE (`requireEnv("TARGET_URL")`, eagerly, on
// import) — by design, so a prod-gate file cannot run without a real target.
// `isPaused` is the one pure export in that file with nothing to do with a
// live target, so it is loaded here via a dynamic import behind a satisfied
// env var, rather than pulling this unit file into the integration lane's
// requirements (or, worse, requiring a real TARGET_URL to run `npm test`).
process.env.TARGET_URL ??= "http://localhost:8080";
const { isPaused } = await import("./integration/_helpers.mjs");

const ENV_KEY = "PAUSED_PLATFORMS";
let saved;

beforeEach(() => {
  saved = process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("isPaused", () => {
  it("unset means nothing is paused", () => {
    delete process.env[ENV_KEY];
    assert.equal(isPaused("sportlots"), false);
    assert.equal(isPaused("buysportscards"), false);
  });

  it("empty string means nothing is paused", () => {
    process.env[ENV_KEY] = "";
    assert.equal(isPaused("sportlots"), false);
  });

  it("a single paused site matches, case-insensitively", () => {
    process.env[ENV_KEY] = "sportlots";
    assert.equal(isPaused("sportlots"), true);
    assert.equal(isPaused("SportLots"), true);
    assert.equal(isPaused("SPORTLOTS"), true);
    assert.equal(isPaused("buysportscards"), false);
  });

  it("comma-separated list with stray whitespace matches every named site", () => {
    process.env[ENV_KEY] = " SportLots , buysportscards";
    assert.equal(isPaused("sportlots"), true);
    assert.equal(isPaused("buysportscards"), true);
  });

  it("a trailing comma with no second entry does not match an unrelated site", () => {
    process.env[ENV_KEY] = "sportlots,";
    assert.equal(isPaused("sportlots"), true);
    assert.equal(isPaused("buysportscards"), false);
  });

  it("a site not named in the list is not paused", () => {
    process.env[ENV_KEY] = "buysportscards";
    assert.equal(isPaused("sportlots"), false);
  });
});
