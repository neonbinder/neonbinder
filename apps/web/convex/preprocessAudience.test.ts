// Unit tests for preprocessAudienceFor (NEO-175) — the OIDC-audience derivation
// that lets a Convex preview talk to a per-PR preprocess-service preview (tagged
// Cloud Run revision) while minting a token whose audience is the *base* service
// URL, which is what Cloud Run IAM validates against. The exact twin of
// browserAudience.test.ts, extended to cover both the heavy and the -fast host.

import { describe, expect, test } from "vitest";
import { preprocessAudienceFor } from "./preprocessAudience";

describe("preprocessAudienceFor", () => {
  test("tagged pr-N preview host of the HEAVY service -> base service origin", () => {
    expect(
      preprocessAudienceFor(
        "https://pr-43---neonbinder-preprocess-xxlo66yxuq-uc.a.run.app",
      ),
    ).toBe("https://neonbinder-preprocess-xxlo66yxuq-uc.a.run.app");
  });

  test("tagged pr-N preview host of the FAST service -> base service origin", () => {
    // The `-fast` segment is part of the base host and must survive the strip.
    expect(
      preprocessAudienceFor(
        "https://pr-43---neonbinder-preprocess-fast-xxlo66yxuq-uc.a.run.app",
      ),
    ).toBe("https://neonbinder-preprocess-fast-xxlo66yxuq-uc.a.run.app");
  });

  test("multi-digit / arbitrary PR numbers strip correctly", () => {
    expect(
      preprocessAudienceFor(
        "https://pr-1207---neonbinder-preprocess-fast-xxlo66yxuq-uc.a.run.app",
      ),
    ).toBe("https://neonbinder-preprocess-fast-xxlo66yxuq-uc.a.run.app");
  });

  test("plain base service URLs are returned unchanged (heavy and fast)", () => {
    const heavy = "https://neonbinder-preprocess-xxlo66yxuq-uc.a.run.app";
    const fast = "https://neonbinder-preprocess-fast-xxlo66yxuq-uc.a.run.app";
    expect(preprocessAudienceFor(heavy)).toBe(heavy);
    expect(preprocessAudienceFor(fast)).toBe(fast);
  });

  test("prod base service URL is returned unchanged", () => {
    const prod = "https://neonbinder-preprocess-qkqlka2ioa-uc.a.run.app";
    expect(preprocessAudienceFor(prod)).toBe(prod);
  });

  test("loopback dev URL is returned unchanged (no OIDC)", () => {
    expect(preprocessAudienceFor("http://localhost:8081")).toBe(
      "http://localhost:8081",
    );
  });

  test("non-run.app host containing --- is left untouched", () => {
    const weird = "https://a---b.example.com";
    expect(preprocessAudienceFor(weird)).toBe(weird);
  });

  test("tagged host of a DIFFERENT run.app service is NOT stripped (fail closed)", () => {
    // Defense-in-depth: only OUR preprocess service hosts are rewritten, so a
    // crafted host can't coerce a token for an attacker-named audience.
    const evil = "https://pr-1---attacker-svc-uc.a.run.app";
    expect(preprocessAudienceFor(evil)).toBe(evil);
  });

  test("a host that merely starts like ours but isn't is NOT stripped", () => {
    // `neonbinder-preprocess.attacker.com` shares the prefix but is not the
    // `-<hash>-uc.a.run.app` shape, so it must fail the allowlist.
    const evil = "https://pr-9---neonbinder-preprocess.attacker.com";
    expect(preprocessAudienceFor(evil)).toBe(evil);
  });

  test("prod tagged preview host strips to prod base origin", () => {
    expect(
      preprocessAudienceFor(
        "https://pr-7---neonbinder-preprocess-fast-qkqlka2ioa-uc.a.run.app",
      ),
    ).toBe("https://neonbinder-preprocess-fast-qkqlka2ioa-uc.a.run.app");
  });

  test("trailing path is ignored — only origin matters for tagged hosts", () => {
    expect(
      preprocessAudienceFor(
        "https://pr-9---neonbinder-preprocess-xxlo66yxuq-uc.a.run.app/process-entry",
      ),
    ).toBe("https://neonbinder-preprocess-xxlo66yxuq-uc.a.run.app");
  });

  test("malformed input is returned verbatim (no throw)", () => {
    expect(preprocessAudienceFor("not a url")).toBe("not a url");
  });
});
