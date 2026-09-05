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
import { NO_MARKETPLACE_IDS_MESSAGE } from "./marketplaceResolvability";

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

/**
 * sport → year → setName, with each side's ids present or deliberately absent.
 *
 * NEO-239 — `custom: true` is gone. There was never anything for it to say
 * that `platformData` did not already say: an unlinked row is a row with no
 * ids, and that is now what the fetch reads.
 */
async function seedChain(
  t: ReturnType<typeof convexTest>,
  opts: { setNameBsc?: string; scopeIds?: boolean },
): Promise<Id<"selectorOptions">> {
  const scoped = opts.scopeIds !== false;
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: scoped
        ? { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } }
        : {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: scoped
        ? { bsc: { b0: "2024" }, sportlots: { s0: "2024" } }
        : {},
      parentId: sport,
      children: [],
      lastUpdated: SENTINEL,
    });
    return ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: opts.setNameBsc ? { bsc: { b0: opts.setNameBsc } } : {},
      parentId: year,
      children: [],
      lastUpdated: SENTINEL,
    });
  });
}

/**
 * A chain where BOTH sides are fully resolvable at level `insert`: every id
 * each side's request body consumes, plus the SL set anchor and the BSC
 * `variant` tag.
 */
async function seedInsertReadyChain(
  t: ReturnType<typeof convexTest>,
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
    const manufacturer = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      parentId: year,
      children: [],
      lastUpdated: SENTINEL,
    });
    const setName = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: { bsc: { b0: "topps-2024" }, sportlots: { s0: "884412" } },
      parentId: manufacturer,
      children: [],
      lastUpdated: SENTINEL,
    });
    return ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      platformData: { bsc: { b0: "insert" } },
      platformFacets: { bsc: { b0: "variant" } },
      parentId: setName,
      children: [],
      lastUpdated: SENTINEL,
    });
  });
}

describe("fetchRawOptions error shape", () => {
  test("a missing BSC id SKIPS that side — it is not an error, and it is declared", async () => {
    // NEO-239, and a REVERSAL of what this used to assert. A missing slug was
    // reported as a BSC `error`, which is the wrong word for it: BSC was never
    // asked. The distinction is not cosmetic — `coveredSides` is built from
    // `errors`, so calling a skip an error and calling it neither would both
    // have put the side into coverage and let the unlink pass detach live
    // links on a side nobody queried. `skippedSides` is the third answer.
    const t = convexTest(schema, modules);
    const setNameId = await seedChain(t, {});
    // SportLots IS asked here — that is the point — so its network has to be
    // stubbed. A 500 stands in for "the marketplace could not answer", which
    // is the state that must stay distinguishable from "we never asked".
    vi.stubGlobal(
      "fetch",
      (async () => new Response("unavailable", { status: 500 })) as typeof fetch,
    );

    const res = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "variantType",
        parentId: setNameId,
      });

    expect(res.success).toBe(true);
    expect(res.skippedSides).toContain("bsc");
    // No BSC entry in `errors`: nothing failed on that side.
    expect(res.errors.some((e) => e.platform === "bsc")).toBe(false);
    expect(res.bscOptions).toEqual([]);
    // NEO-239 (the CI cluster) — SportLots is skipped HERE TOO, for a second,
    // independent reason: it does not SERVE `variantType` at all
    // (`fetchSportLotsSelectorOptions` answers `unsupported_level`). Judging it
    // resolvable from sport+year alone is what made ten flows call a
    // marketplace on a hand-made set and render the empty answer as a failure.
    expect(res.skippedSides).toContain("sportlots");
    expect(res.errors).toEqual([]);
  });

  test("a path with no marketplace ids at all is a clean SKIP, not an error", async () => {
    const t = convexTest(schema, modules);
    const setNameId = await seedChain(t, { scopeIds: false });

    const res = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "variantType",
        parentId: setNameId,
      });

    // Neither adapter is called and `errors` stays EMPTY — the form routes
    // empty-and-clean to "+ Custom" rather than to a Retry it could never
    // satisfy.
    expect(res.success).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.skippedSides.sort()).toEqual(["bsc", "sportlots"]);
    expect(res.message).toBe(NO_MARKETPLACE_IDS_MESSAGE);
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
    // NEO-216 + NEO-239: driven at `insert`, the level BOTH marketplaces serve.
    // This used to run at `variantType` and still saw two entries — because
    // SportLots was being called at a level it does not have, failed on the
    // dead browser service, and was counted as an outage. That conflation is
    // the bug NEO-216 fixes; the two-entry SHAPE this test exists to pin is
    // real, so it moves to a level where both sides genuinely answer.
    //
    // The fixture has to satisfy both gates for both sides, which is why it is
    // its own seed: SportLots needs sport + year + manufacturer ids and a
    // linked set, BSC needs sport + year + setName ids and a `variant`-tagged
    // slot on the variantType row. Anything less and a side is SKIPPED rather
    // than failing, and there is no second entry to assert.
    const t = convexTest(schema, modules);
    const variantTypeId = await seedInsertReadyChain(t);

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
        // Inserts hang off the variantType row, so that is the parent.
        parentId: variantTypeId,
      });

    expect(res.success).toBe(true);
    expect(res.skippedSides).toEqual([]);
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
