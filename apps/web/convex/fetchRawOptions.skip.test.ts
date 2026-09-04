/**
 * NEO-239 — `fetchRawOptions` on a hand-made subtree must be a CLEAN SKIP.
 *
 * Ten Maestro flows drill a per-worker subtree (`E2E Test Sport N` / 2026 / …)
 * built entirely by hand, with no marketplace ids anywhere, and expect every
 * column down the tree to reach the idle "+ Custom" state instantly. The
 * Inserts column is `VariantForm` → `fetchRawOptions`, and CI showed it
 * rendering "Sync failed: could not load variants. Nothing was changed." plus
 * Retry instead.
 *
 * This file pins the RESULT SHAPE that column branches on, because the failure
 * is a contract between two agents' halves and a prose description of it is
 * not a test. The shape has to be unambiguous in all three states:
 *
 *   neither side resolvable  → a skip: success, NO errors, both sides in
 *                              `skippedSides`, the fixed message. Nothing was
 *                              attempted, so there is nothing to retry.
 *   one side resolvable      → that side is fetched; the other is in
 *                              `skippedSides` and contributes NO error entry.
 *   a side that FAILED       → an error entry, and NOT in `skippedSides`.
 *
 * The third is what makes the first two meaningful: "was never asked" and
 * "was asked and could not answer" must stay distinguishable, or `coveredSides`
 * is built from a lie and the unlink pass detaches live links.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  NO_MARKETPLACE_IDS_MESSAGE,
  resolvableSides,
} from "./marketplaceResolvability";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_raw_skip",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_raw_skip",
  role: "admin",
};

const SENTINEL = 1_000_000;

/** Credentials are not under test — hand both adapters a token. */
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => ({ token: "test-token" }),
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The Maestro fixture: sport → year → manufacturer → setName → variantType,
 * every row typed by hand through "+ Custom", nothing linked anywhere.
 *
 * `linked` opts individual levels into marketplace ids so the one-sided cases
 * below can be built from the same tree.
 */
async function seedHandMadeSubtree(
  t: ReturnType<typeof convexTest>,
  linked: {
    bsc?: boolean;
    sportlots?: boolean;
    variantTag?: boolean;
  } = {},
): Promise<{
  variantTypeId: Id<"selectorOptions">;
  insertId: Id<"selectorOptions">;
}> {
  const bsc = (id: string) => (linked.bsc ? { bsc: { b0: id } } : {});
  const sl = (id: string) => (linked.sportlots ? { sportlots: { s0: id } } : {});
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "E2E Test Sport 3",
      platformData: { ...bsc("baseball"), ...sl("BB") },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2026",
      platformData: { ...bsc("2026"), ...sl("2026") },
      parentId: sport,
      children: [],
      lastUpdated: SENTINEL,
    });
    const manufacturer = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "E2E Brand",
      // SL scopes its set list by `brd`, so a resolvable SL side needs this.
      platformData: { ...sl("TP") },
      parentId: year,
      children: [],
      lastUpdated: SENTINEL,
    });
    const setName = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "E2E Set",
      // The SL ANCHOR: without an SL id beneath the manufacturer, SL's flat
      // year+brand list is not "this set's variants".
      platformData: { ...bsc("e2e-set"), ...sl("884412") },
      parentId: manufacturer,
      children: [],
      lastUpdated: SENTINEL,
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      platformData: { ...bsc("insert") },
      ...(linked.variantTag
        ? { platformFacets: { bsc: { b0: "variant" } } }
        : {}),
      parentId: setName,
      children: [],
      lastUpdated: SENTINEL,
    });
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "E2E Variant",
      platformData: {},
      parentId: variantTypeId,
      children: [],
      lastUpdated: SENTINEL,
    });
    return { variantTypeId, insertId };
  });
}

const fetchRaw = (
  t: ReturnType<typeof convexTest>,
  level: "insert" | "parallel",
  parentId: Id<"selectorOptions">,
) =>
  t.withIdentity(ADMIN).action(api.setReconciliation.fetchRawOptions, {
    level,
    parentId,
  });

describe("fetchRawOptions — a hand-made subtree is a clean skip", () => {
  test.each(["insert", "parallel"] as const)(
    "level %s with NO ids anywhere: success, no errors, both sides skipped",
    async (level) => {
      const t = convexTest(schema, modules);
      const { variantTypeId, insertId } = await seedHandMadeSubtree(t);
      const parentId = level === "insert" ? variantTypeId : insertId;

      const res = await fetchRaw(t, level, parentId);

      // THE CONTRACT the Inserts column branches on. `errors` empty is what
      // routes the form to onDone (idle, "+ Custom") rather than to a Retry
      // that could never succeed — nothing was attempted, so there is nothing
      // to retry.
      expect(res.success).toBe(true);
      expect(res.errors).toEqual([]);
      expect(res.bscOptions).toEqual([]);
      expect(res.slOptions).toEqual([]);
      expect(res.autoMatched).toEqual([]);
      expect(res.skippedSides.slice().sort()).toEqual(["bsc", "sportlots"]);
      expect(res.message).toBe(NO_MARKETPLACE_IDS_MESSAGE);
    },
  );

  test("no marketplace is contacted at all", async () => {
    // The other half of "instant": 37 flows depend on this column settling
    // without a round trip. A skip that still opened a socket would pass the
    // shape assertions above and still hang the drill.
    const outgoing: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL | Request) => {
        outgoing.push(String(url));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    );
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedHandMadeSubtree(t);

    await fetchRaw(t, "insert", variantTypeId);

    expect(outgoing).toEqual([]);
  });
});

describe("fetchRawOptions — one side resolvable", () => {
  test("SportLots resolves, BSC is skipped and contributes NO error", async () => {
    // A skipped side must never look like a failed one. `coveredSides` is
    // derived from `errors`, so an error entry here would license the unlink
    // pass to detach every child row's BSC slot on a side nobody queried.
    vi.stubGlobal(
      "fetch",
      (async () => new Response("<html></html>", { status: 200 })) as typeof fetch,
    );
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedHandMadeSubtree(t, { sportlots: true });

    const res = await fetchRaw(t, "insert", variantTypeId);

    expect(res.success).toBe(true);
    expect(res.skippedSides).toEqual(["bsc"]);
    expect(res.errors.some((e) => e.platform === "bsc")).toBe(false);
    expect(res.bscOptions).toEqual([]);
  });

  test("BSC resolves, SportLots is skipped and contributes NO error", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ aggregations: { variantName: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedHandMadeSubtree(t, {
      bsc: true,
      variantTag: true,
    });

    const res = await fetchRaw(t, "insert", variantTypeId);

    expect(res.success).toBe(true);
    expect(res.skippedSides).toEqual(["sportlots"]);
    expect(res.errors.some((e) => e.platform === "sportlots")).toBe(false);
  });

  test("a side that FAILED is an error and is NOT in skippedSides", async () => {
    // The distinction the whole `skippedSides` field exists to preserve.
    vi.stubGlobal(
      "fetch",
      (async () => new Response("boom", { status: 500 })) as typeof fetch,
    );
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedHandMadeSubtree(t, { sportlots: true });

    const res = await fetchRaw(t, "insert", variantTypeId);

    // BSC was never asked…
    expect(res.skippedSides).toEqual(["bsc"]);
    // …and SportLots was asked and could not answer, so it says so.
    expect(res.errors.some((e) => e.platform === "sportlots")).toBe(true);
    expect(res.skippedSides).not.toContain("sportlots");
  });
});

describe("ensureSelectorOptions on the same subtree writes NO error status", () => {
  test("the variantType column goes idle instantly, with the status row cleared", async () => {
    // The other message CI showed on this screen was
    // "Couldn't sync options — please try again." (`SYNC_ERROR_MESSAGE`), which
    // only `ensureSelectorOptions`' catch writes. The columns above Inserts DO
    // use that path, so this pins that a zero-id chain reaches the skip before
    // anything can throw — `ran: false`, both sides declared skipped, and any
    // leftover notice actively CLEARED so the column reaches idle rather than
    // "idle with a stale error".
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variantTypeId } = await seedHandMadeSubtree(t);
    const setNameId = (await t.run(async (ctx) => ctx.db.get(variantTypeId)))!
      .parentId!;

    await t.mutation(internal.selectorOptions.setSelectorSyncStatus, {
      level: "variantType",
      parentId: setNameId,
      status: "error",
      message: "left over from a previous run",
    });

    const res = await asAdmin.action(
      api.selectorOptions.ensureSelectorOptions,
      { level: "variantType", parentId: setNameId, force: true },
    );

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("no_marketplace_ids");
    expect(res.skippedSides.slice().sort()).toEqual(["bsc", "sportlots"]);
    expect(
      await asAdmin.query(api.selectorOptions.getSelectorSyncStatus, {
        level: "variantType",
        parentId: setNameId,
      }),
    ).toBeNull();
  });
});

describe("the EXACT call VariantForm makes", () => {
  test("with parentFilters and baseSlPrefix, it still returns the clean skip", async () => {
    // My first pass omitted `parentFilters` and `baseSlPrefix`, which the form
    // always sends. A skip that only holds for the trimmed call is not the
    // contract the column relies on — and an args/returns validation error
    // would surface in the form's CATCH as
    // "Sync failed: could not load variants. Nothing was changed.", which is
    // exactly what CI showed.
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedHandMadeSubtree(t);

    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "insert",
        parentId: variantTypeId,
        parentFilters: {
          sport: "E2E Test Sport 3",
          year: "2026",
          manufacturer: "E2E Brand",
          setName: "E2E Set",
          variantType: "Insert",
        },
        baseSlPrefix: "E2E Set",
      });

    expect(res.success).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.skippedSides.slice().sort()).toEqual(["bsc", "sportlots"]);
  });

  test("getBaseVariantBySet on a subtree with no base row answers null, it does not throw", async () => {
    // The form resolves `baseSlPrefix` through this query before every sync.
    // NEO-239 changed it from a name check to `metadata.isBase`, and a
    // hand-made subtree has no row holding the role — so `null` is the answer
    // the form must get. A throw here lands in the same catch.
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedHandMadeSubtree(t);
    const setId = (await t.run(async (ctx) => ctx.db.get(variantTypeId)))!
      .parentId!;

    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.selectorOptions.getBaseVariantBySet, { setId }),
    ).toBeNull();
  });
});

// ===========================================================================
// THE CI CLUSTER — a MIXED chain: real sport/year/manufacturer, id-less set
// ===========================================================================

/**
 * Ten flows drill this shape, and it is not the fully synthetic one above:
 * `Baseball / 2024 / Topps` are real rows carrying ids on both sides, and only
 * the SET (and everything under it) is hand-made.
 *
 * Under the `isCustom` gate the hand-made set made the WHOLE subtree skip both
 * marketplaces. `SL_REQUIRED_LEVELS = {sport, year}` judges SportLots
 * resolvable from the real ancestors alone, so it gets asked at levels where
 * its answer cannot mean what the caller needs — and the column reports a
 * failure on a set the operator only wanted to add rows to by hand.
 */
async function seedMixedSubtree(t: ReturnType<typeof convexTest>): Promise<{
  setNameId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
}> {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sport,
      children: [],
      lastUpdated: SENTINEL,
    });
    const manufacturer = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: year,
      children: [],
      lastUpdated: SENTINEL,
    });
    // Hand-made from here down — no ids on either side.
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "E2E Hand Made Set",
      platformData: {},
      parentId: manufacturer,
      children: [],
      lastUpdated: SENTINEL,
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
    return { setNameId, variantTypeId };
  });
}

describe("MIXED chain — real ancestors, hand-made set", () => {
  test("fetchRawOptions at insert does not throw, and skips BOTH sides", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedMixedSubtree(t);

    const res = await fetchRaw(t, "insert", variantTypeId);

    // "does not throw" first: VariantForm's doSync catch is the only thing
    // that produces "Sync failed: could not load variants. Nothing was
    // changed.", so a rejection here IS the CI symptom.
    expect(res.success).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.skippedSides.slice().sort()).toEqual(["bsc", "sportlots"]);
  });

  test("ensureSelectorOptions at variantType clears the status, never errors", async () => {
    const t = convexTest(schema, modules);
    const { setNameId } = await seedMixedSubtree(t);
    const asAdmin = t.withIdentity(ADMIN);

    const res = await asAdmin.action(
      api.selectorOptions.ensureSelectorOptions,
      { level: "variantType", parentId: setNameId, force: true },
    );

    expect(res.skippedSides.slice().sort()).toEqual(["bsc", "sportlots"]);
    expect(
      await asAdmin.query(api.selectorOptions.getSelectorSyncStatus, {
        level: "variantType",
        parentId: setNameId,
      }),
    ).toBeNull();
  });

  test("SportLots is skipped at setName because it does not SERVE that level", async () => {
    // Not about ids at all: `fetchSportLotsSelectorOptions` answers `setName`,
    // `variantType` and `parallel` with a documented `unsupported_level` empty
    // result. Judging it resolvable there made the caller read "structurally
    // empty" as "reached and genuinely empty" — which reports "no options from
    // any platform" and, worse, licenses the unlink pass on that side.
    const t = convexTest(schema, modules);
    const { setNameId } = await seedMixedSubtree(t);
    const manufacturerId = (await t.run(async (ctx) => ctx.db.get(setNameId)))!
      .parentId!;
    // BSC IS asked here — sport and year carry its ids and it serves setName —
    // so its network has to be stubbed. That asymmetry is the point of the
    // test: one side asked, the other structurally unable to answer.
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ aggregations: { setName: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );

    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "setName",
        parentId: manufacturerId,
      });

    expect(res.success).toBe(true);
    expect(res.skippedSides).toContain("sportlots");
    // …and no error entry for it: it was never asked.
    expect(res.errors.some((e) => e.platform === "sportlots")).toBe(false);
  });
});

// ===========================================================================
// THE SEED'S REAL SET — the Base mapping picker must get SL candidates
// ===========================================================================

/**
 * 2024 Topps Chrome exactly as the seed leaves it when the operator taps
 * "Base", and the shape that broke in CI run 6.
 *
 * The detail that matters: `syncSetsAcrossManufacturers` is BSC-ONLY, so the
 * setName row carries a BSC id and NO SportLots one, and "Sync Variant Types"
 * is BSC-only too. The Base picker is how this set gets its SL id — so any
 * rule that requires an SL id *before* listing SL sets is circular, and the
 * failure is silent: `BaseMappingForm` sees `slOptions: []`, takes its
 * "no SL data → auto-write bscOptions[0]" branch, closes, and neither
 * "Select Base Set" nor "Re-map Base" renders (the latter is SL-keyed).
 */
async function seedRealSetAwaitingBaseMapping(
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
      value: "Topps Chrome",
      // BSC only — the set sync never writes a SportLots id.
      platformData: { bsc: { b0: "2024-topps-chrome" } },
      parentId: manufacturer,
      children: [],
      lastUpdated: SENTINEL,
    });
    // What "Sync Variant Types" wrote: a `variant`-tagged BSC slot, the base
    // role, and nothing on SportLots.
    return ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "base" } },
      platformFacets: { bsc: { b0: "variant" } },
      metadata: { isBase: true },
      primaryPlatformId: { bsc: "b0" },
      platformSlotSeq: { bsc: 1 },
      parentId: setName,
      children: [],
      lastUpdated: SENTINEL,
    });
  });
}

describe("BaseMappingForm's fetch on the seed's real set", () => {
  test("SportLots IS asked and returns set candidates for the picker", async () => {
    const t = convexTest(schema, modules);
    const baseId = await seedRealSetAwaitingBaseMapping(t);

    vi.stubGlobal(
      "fetch",
      (async (url: string | URL | Request) => {
        // BSC's variantName facet is usually empty under variant=base — that
        // is precisely why the picker needs the SportLots list.
        if (String(url).includes("buysportscards")) {
          return new Response(
            JSON.stringify({ aggregations: { variantName: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          `<input type="radio" Name="selset" Value="884412"></td> <td>1  Topps Chrome</td>` +
            `<input type="radio" Name="selset" Value="884413"></td> <td>2  Topps Chrome Update</td>`,
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    // The exact call BaseMappingForm makes: level "insert", parentId = the
    // Base variantType row.
    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "insert",
        parentId: baseId,
        parentFilters: {
          sport: "Baseball",
          year: "2024",
          manufacturer: "Topps",
          setName: "Topps Chrome",
          variantType: "Base",
        },
      });

    expect(res.success).toBe(true);
    // THE REGRESSION: SportLots must not be skipped here. A skip sends
    // BaseMappingForm down its silent auto-write branch and the picker never
    // opens.
    expect(res.skippedSides).not.toContain("sportlots");
    expect(res.slOptions.length).toBeGreaterThan(0);
    expect(res.slOptions.map((o) => o.platformValue)).toContain("884412");
  });

  test("the set being BSC-linked is what licenses the SL list — not an SL id", async () => {
    // The rule is "this set is a marketplace set at all", satisfied by the BSC
    // id the set sync wrote. Requiring the SportLots one would be circular:
    // the picker this fetch feeds is how that id comes to exist.
    const t = convexTest(schema, modules);
    const baseId = await seedRealSetAwaitingBaseMapping(t);
    const setNameId = (await t.run(async (ctx) => ctx.db.get(baseId)))!.parentId!;
    const chain = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.getAncestorChain, { id: baseId });

    expect(
      resolvableSides(chain, { level: "insert" }).sportlots.resolvable,
    ).toBe(true);

    // Strip the set's only id and it becomes NB's own invention — then SL's
    // year+brand list is a superset offered as one set's variants, and the
    // side is skipped. That is the ten-flow case.
    await t.run(async (ctx) =>
      ctx.db.patch(setNameId, { platformData: {} }),
    );
    const unlinked = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.getAncestorChain, { id: baseId });
    expect(
      resolvableSides(unlinked, { level: "insert" }).sportlots.resolvable,
    ).toBe(false);
  });
});
