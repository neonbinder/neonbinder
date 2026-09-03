// NEO-121 — the webhook signature contract, pinned against `node:crypto`.
//
// WHY THE VECTOR IS COMPUTED HERE RATHER THAN HARDCODED: the implementation
// under test uses Web Crypto (`crypto.subtle`), because the webhook handler is
// an `httpAction` and cannot reach `node:crypto`. A test written against the
// same primitive would only prove the code is self-consistent. Computing the
// expectation with `node:crypto` — the primitive EasyPost's own library uses —
// is what makes these tests evidence that a REAL event will verify.
//
// The `weight` rewrite is covered as a separate contract because it is the one
// piece of this that is not obvious: EasyPost signs the FLOAT-rendered body, so
// an integer `"weight": 17` has to become `17.0` before hashing. Without it,
// production events fail verification and no scan ever lands — while every
// handcrafted test payload (which tends to use a decimal weight) passes.

import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  computeEasypostSignature,
  constantTimeEqual,
  rewriteWeightForSignature,
} from "./easypostWebhookSignature";

const SECRET = "s3cret-webhook-key-that-is-32-chars";

function nodeSignature(secret: string, body: string): string {
  return (
    "hmac-sha256-hex=" +
    createHmac("sha256", secret.normalize("NFKD")).update(body, "utf8").digest("hex")
  );
}

describe("computeEasypostSignature", () => {
  test("matches an HMAC-SHA256 computed by node:crypto", async () => {
    const body = JSON.stringify({ description: "tracker.updated", result: { id: "trk_1" } });
    expect(await computeEasypostSignature(SECRET, body)).toBe(nodeSignature(SECRET, body));
  });

  test("carries the `hmac-sha256-hex=` prefix and 64 hex characters", async () => {
    const signature = await computeEasypostSignature(SECRET, "{}");
    expect(signature).toMatch(/^hmac-sha256-hex=[0-9a-f]{64}$/);
  });

  test("normalises the secret NFKD, as EasyPost's library does", async () => {
    // Two spellings of the same text: precomposed é vs. e + combining accent.
    // EasyPost normalises before keying, so both must key identically.
    const composed = "clé-de-webhook-composed-form-key";
    const decomposed = composed.normalize("NFD");
    expect(composed).not.toBe(decomposed);
    expect(await computeEasypostSignature(decomposed, "{}")).toBe(
      await computeEasypostSignature(composed, "{}"),
    );
  });

  test("a different body produces a different signature", async () => {
    expect(await computeEasypostSignature(SECRET, '{"a":1}')).not.toBe(
      await computeEasypostSignature(SECRET, '{"a":2}'),
    );
  });
});

describe("rewriteWeightForSignature", () => {
  test("renders an integer weight as a float, before a comma and before a brace", () => {
    expect(rewriteWeightForSignature('{"weight": 17,"x":1}')).toBe('{"weight": 17.0,"x":1}');
    expect(rewriteWeightForSignature('{"weight": 17}')).toBe('{"weight": 17.0}');
    expect(rewriteWeightForSignature('{"weight":17}')).toBe('{"weight":17.0}');
  });

  test("leaves a decimal weight alone", () => {
    // The bug this guards: a digit-run that backtracks into a match would turn
    // 17.5 into "1" + "7.0.5" and break verification on every fractional weight.
    expect(rewriteWeightForSignature('{"weight": 17.5}')).toBe('{"weight": 17.5}');
    expect(rewriteWeightForSignature('{"weight":0.9,"y":2}')).toBe('{"weight":0.9,"y":2}');
  });

  test("leaves a string weight alone", () => {
    expect(rewriteWeightForSignature('{"weight": "17"}')).toBe('{"weight": "17"}');
  });

  test("rewrites every occurrence — a shipment carries weight twice", () => {
    expect(
      rewriteWeightForSignature('{"weight": 3,"parcel":{"weight": 3},"n":1}'),
    ).toBe('{"weight": 3.0,"parcel":{"weight": 3.0},"n":1}');
  });

  test("the rewritten body is what node:crypto signs", async () => {
    const raw = '{"description":"tracker.updated","result":{"weight": 17}}';
    const rewritten = rewriteWeightForSignature(raw);
    expect(rewritten).toContain('"weight": 17.0');
    expect(await computeEasypostSignature(SECRET, rewritten)).toBe(
      nodeSignature(SECRET, rewritten),
    );
    // And emphatically NOT what the raw body signs — this inequality is the
    // whole reason the rewrite exists.
    expect(await computeEasypostSignature(SECRET, rewritten)).not.toBe(
      nodeSignature(SECRET, raw),
    );
  });
});

describe("constantTimeEqual", () => {
  test("true only for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  test("false for different lengths, including a prefix", () => {
    // A prefix must not pass: `startsWith`/`includes` comparisons are exactly
    // the mistake this function exists to prevent.
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("hmac-sha256-hex=", "hmac-sha256-hex=deadbeef")).toBe(false);
  });
});
