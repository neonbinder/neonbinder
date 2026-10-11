import { describe, expect, test } from "vitest";
import { ConfirmMismatch, TargetError, assertConfirm, confirmPhrase, parseTarget } from "./target";

describe("parseTarget", () => {
  test("a Convex cloud URL yields its .convex.site twin and its host", () => {
    expect(parseTarget("https://happy-otter-123.convex.cloud/")).toEqual({
      convexUrl: "https://happy-otter-123.convex.cloud",
      convexSite: "https://happy-otter-123.convex.site",
      host: "happy-otter-123.convex.cloud",
    });
  });

  test("a local backend serves HTTP actions on the next port", () => {
    expect(parseTarget("http://127.0.0.1:3210")).toEqual({
      convexUrl: "http://127.0.0.1:3210",
      convexSite: "http://127.0.0.1:3211",
      host: "127.0.0.1:3210",
    });
  });

  test("a custom domain needs an explicit site URL", () => {
    expect(() => parseTarget("https://api.example.com")).toThrow(/--convex-site-url/);
    expect(parseTarget("https://api.example.com", { siteUrl: "https://site.example.com/x" }).convexSite).toBe(
      "https://site.example.com",
    );
  });

  test("refuses plain http off-box, a path, and non-URLs", () => {
    expect(() => parseTarget("http://happy-otter-123.convex.cloud")).toThrow(TargetError);
    expect(() => parseTarget("https://happy-otter-123.convex.cloud/api")).toThrow(/origin/);
    expect(() => parseTarget("https://happy-otter-123.convex.cloud/?x=1")).toThrow(/origin/);
    expect(() => parseTarget("happy-otter-123")).toThrow(TargetError);
  });
});

describe("confirm phrase", () => {
  const t = parseTarget("https://happy-otter-123.convex.cloud");

  test("is BUILD <host> <scope>", () => {
    expect(confirmPhrase(t, " e2e-baseline ")).toBe("BUILD happy-otter-123.convex.cloud e2e-baseline");
    expect(confirmPhrase(t, "Baseball/2024/Topps/Topps Chrome")).toBe(
      "BUILD happy-otter-123.convex.cloud Baseball/2024/Topps/Topps Chrome",
    );
    expect(() => confirmPhrase(t, "  ")).toThrow(TargetError);
  });

  test("assertConfirm accepts only the exact phrase and names the expected one", () => {
    expect(() => assertConfirm(t, "e2e-baseline", "BUILD happy-otter-123.convex.cloud e2e-baseline")).not.toThrow();
    for (const given of [
      undefined,
      "",
      "BUILD happy-otter-123.convex.cloud e2e-baseline ",
      "build happy-otter-123.convex.cloud e2e-baseline",
      "BUILD other-deploy-9.convex.cloud e2e-baseline",
    ]) {
      let caught: unknown;
      try {
        assertConfirm(t, "e2e-baseline", given);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfirmMismatch);
      expect((caught as ConfirmMismatch).expected).toBe("BUILD happy-otter-123.convex.cloud e2e-baseline");
      expect((caught as Error).message).toContain("BUILD happy-otter-123.convex.cloud e2e-baseline");
    }
  });
});
