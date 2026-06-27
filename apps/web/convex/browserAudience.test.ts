// Unit tests for oidcAudienceFor — the OIDC-audience derivation that lets a
// Convex preview talk to a per-PR browser-service preview (tagged Cloud Run
// revision) while minting a token whose audience is the *base* service URL,
// which is what Cloud Run IAM validates against.

import { describe, expect, test } from "vitest";
import { oidcAudienceFor } from "./browserAudience";

describe("oidcAudienceFor", () => {
  test("tagged pr-N preview host -> base service origin", () => {
    expect(
      oidcAudienceFor(
        "https://pr-43---neonbinder-browser-xxlo66yxuq-uc.a.run.app",
      ),
    ).toBe("https://neonbinder-browser-xxlo66yxuq-uc.a.run.app");
  });

  test("multi-digit / arbitrary PR numbers strip correctly", () => {
    expect(
      oidcAudienceFor(
        "https://pr-1207---neonbinder-browser-xxlo66yxuq-uc.a.run.app",
      ),
    ).toBe("https://neonbinder-browser-xxlo66yxuq-uc.a.run.app");
  });

  test("plain base service URL is returned unchanged", () => {
    const base = "https://neonbinder-browser-xxlo66yxuq-uc.a.run.app";
    expect(oidcAudienceFor(base)).toBe(base);
  });

  test("prod base service URL is returned unchanged", () => {
    const prod = "https://neonbinder-browser-qkqlka2ioa-uc.a.run.app";
    expect(oidcAudienceFor(prod)).toBe(prod);
  });

  test("loopback dev URL is returned unchanged (no OIDC)", () => {
    expect(oidcAudienceFor("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
  });

  test("non-run.app host containing --- is left untouched", () => {
    const weird = "https://a---b.example.com";
    expect(oidcAudienceFor(weird)).toBe(weird);
  });

  test("tagged host of a DIFFERENT run.app service is NOT stripped (fail closed)", () => {
    // Defense-in-depth: only OUR neonbinder-browser service host is rewritten,
    // so a crafted host can't coerce a token for an attacker-named audience.
    const evil = "https://pr-1---attacker-svc-uc.a.run.app";
    expect(oidcAudienceFor(evil)).toBe(evil);
  });

  test("prod tagged preview host strips to prod base origin", () => {
    expect(
      oidcAudienceFor("https://pr-7---neonbinder-browser-qkqlka2ioa-uc.a.run.app"),
    ).toBe("https://neonbinder-browser-qkqlka2ioa-uc.a.run.app");
  });

  test("trailing path is ignored — only origin matters for tagged hosts", () => {
    expect(
      oidcAudienceFor(
        "https://pr-9---neonbinder-browser-xxlo66yxuq-uc.a.run.app/credentials",
      ),
    ).toBe("https://neonbinder-browser-xxlo66yxuq-uc.a.run.app");
  });

  test("malformed input is returned verbatim (no throw)", () => {
    expect(oidcAudienceFor("not a url")).toBe("not a url");
  });
});
