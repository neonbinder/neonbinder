/**
 * NEO-211 B — `fetchRawOptions`' per-platform error shape, asserted directly
 * for the first time.
 *
 * This action returns `success: true` with a populated `errors: [{ platform,
 * message }]` when ONE marketplace fails. `VariantForm` / `ParallelForm` then
 * took the single-platform branch and stored whatever came back without ever
 * looking at `errors` — which, before NEO-211, deleted every row linked only
 * to the side that was down and stripped that side's linkage off the rest.
 *
 * The store is now safe on its own (a caller that says nothing about coverage
 * unlinks nothing), but the forms still have to be able to TELL a partial
 * failure from an empty result, and that is what this shape is for. These
 * tests pin it so the FE can rely on it.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo211_raw",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo211_raw",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NEONBINDER_BROWSER_URL;
});

/** sport → year → setName, with BSC slugs present or deliberately missing. */
async function seedChain(
  t: ReturnType<typeof convexTest>,
  opts: { setNameBsc?: string; custom?: boolean },
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      parentId: sport,
      children: [],
      lastUpdated: SENTINEL,
    });
    return ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: opts.setNameBsc ? { bsc: { b0: opts.setNameBsc } } : {},
      ...(opts.custom ? { isCustom: true } : {}),
      parentId: year,
      children: [],
      lastUpdated: SENTINEL,
    });
  });
}

describe("fetchRawOptions error shape", () => {
  test("a missing BSC slug is reported per-platform, and names the level", async () => {
    const t = convexTest(schema, modules);
    const setNameId = await seedChain(t, {});

    const res = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "variantType",
        parentId: setNameId,
      });

    // `success: true` with a populated `errors` is the contract: the fetch
    // itself did not blow up, one platform could not be queried. A caller that
    // reads only `success` cannot tell this from "there are no variants", which
    // is exactly the confusion that made the single-platform branch destructive.
    expect(res.success).toBe(true);
    expect(res.errors).toEqual([
      {
        platform: "bsc",
        message: expect.stringContaining("Missing platformData.bsc on:"),
      },
    ]);
    expect(res.errors[0].message).toContain("setName=Topps");
    expect(res.bscOptions).toEqual([]);
    expect(res.slOptions).toEqual([]);
  });

  test("a custom subtree is a clean SKIP, not an error", async () => {
    const t = convexTest(schema, modules);
    const setNameId = await seedChain(t, { custom: true });

    const res = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "variantType",
        parentId: setNameId,
      });

    // No marketplace presence below a custom node, so neither adapter is
    // called and `errors` stays EMPTY — the form routes empty-and-clean to
    // "+ Custom" rather than to a Retry it could never satisfy.
    expect(res.success).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.message).toContain("Custom subtree");
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const setNameId = await seedChain(t, {});
    await expect(
      t
        .withIdentity({
          subject: "u",
          issuer: "https://clerk.example.com",
          tokenIdentifier: "clerk|u",
          role: "user",
        })
        .action(api.setReconciliation.fetchRawOptions, {
          level: "variantType",
          parentId: setNameId,
        }),
    ).rejects.toThrow();
  });
});

describe("fetchRawOptions when an adapter throws", () => {
  test("each failing platform gets its own { platform, message } entry", async () => {
    // NEO-216: driven at `insert`, the level BOTH marketplaces serve. This used
    // to run at `variantType` and still saw two entries — because SportLots was
    // being called at a level it does not have, failed on the dead browser
    // service, and was counted as an outage. That conflation is the bug NEO-216
    // fixes; the two-entry SHAPE this test exists to pin is real, so it moves to
    // a level where both sides genuinely answer.
    const t = convexTest(schema, modules);
    const setNameId = await seedChain(t, { setNameBsc: "topps-2024" });

    // Loopback → the OIDC path short-circuits, so no GCP credentials are
    // needed; every browser-service call then fails with the body below.
    process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      if (String(url).endsWith("/health")) {
        return new Response(
          JSON.stringify({ status: "ok", environment: "test", contractVersion: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        "https://marketplace.example/login?token=SUPERSECRET failed",
        { status: 500 },
      );
    });

    const res = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "insert",
        parentId: setNameId,
      });

    expect(res.success).toBe(true);
    const platforms = res.errors.map((e) => e.platform).sort();
    expect(platforms).toEqual(["bsc", "sportlots"]);
    for (const e of res.errors) expect(typeof e.message).toBe("string");
  }, 60_000);

  test("a platform that does not serve the level is not among them (NEO-216)", async () => {
    // Same dead browser service, one level up. SportLots does not model
    // `variantType`, so it is not called and cannot be blamed — only BSC, which
    // does serve it and really did fail, is reported. Without this the forms'
    // alert named a marketplace that was never asked anything.
    const t = convexTest(schema, modules);
    const setNameId = await seedChain(t, { setNameBsc: "topps-2024" });

    process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      if (String(url).endsWith("/health")) {
        return new Response(
          JSON.stringify({ status: "ok", environment: "test", contractVersion: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("upstream failed", { status: 500 });
    });

    const res = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "variantType",
        parentId: setNameId,
      });

    expect(res.success).toBe(true);
    expect(res.errors.map((e) => e.platform)).toEqual(["bsc"]);
  }, 60_000);
});
