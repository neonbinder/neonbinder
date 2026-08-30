/**
 * NEO-189 — the N:M set mapping, end to end through `fetchCardChecklist`.
 *
 * The product owner's case, in their words: "Think of this as Topps having
 * Series 1 & Series 2. Sometimes BSC will have one set that is 2024 -> Topps ->
 * Topps -> Base and SL will make Series 1 and Series 2 two different set ids.
 * And sometimes SL will have one set for Topps and BSC will have two sets…
 * Same can be said for parallel/insert sets."
 *
 * The SportLots direction already worked — `fetchCardChecklist` fans out one
 * call per attached SL set id. The BSC direction did not, and failed silently:
 *
 *   • a BSC id attached to a Base (`variantType`) or Parallel row was
 *     DISCARDED before the request was built, because the fetch bucketed ids
 *     by the NB level of the row holding them and neither level maps to a BSC
 *     facet; and
 *   • had two setName slugs reached the request, they would have gone out as
 *     one multi-value facet, which BSC answers 200 OK with an empty body.
 *
 * Either way: zero BSC cards, no error, and a UI reporting "0 BSC cards" as
 * though the marketplace had nothing.
 *
 * These tests stub `fetch` and assert on the OUTGOING REQUEST BODIES. That is
 * the only layer where this class of bug is visible — the sibling checklist
 * tests replace `fetchBscChecklist` wholesale and never see what BSC receives.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_189",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_189",
  name: "Admin",
  role: "admin",
};

/** Credentials are not under test — hand the adapter a token. */
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => ({ token: "test-bsc-token" }),
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

/**
 * SportLots is stubbed out entirely. This file is about what BSC receives, and
 * the SL path already had its fan-out; leaving the real adapter in would drag
 * an HTML scrape and a session cookie into a test about request bodies.
 */
const slState = vi.hoisted(() => ({ cards: [] as unknown[] }));
vi.mock("./adapters/sportlots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/sportlots")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchSportLotsChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.string())),
      },
      returns: v.object({
        success: v.boolean(),
        cards: v.array(v.any()),
        message: v.optional(v.string()),
      }),
      handler: async () => ({ success: true, cards: slState.cards }),
    }),
  };
});

type Recorded = Record<string, string[]>;

/**
 * Stub BSC's bulk-upload endpoint. `perSet` maps a setName slug -> the card
 * numbers filed under it. Any request carrying two values on ONE facet returns
 * 200 OK with no rows, which is what the real API does.
 */
function stubBsc(perSet: Record<string, string[]>, recorded: Recorded[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    // Only the catalog endpoint is under test. `fetchCardChecklist` also calls
    // BSC's per-card team lookup, and recording that would make the request
    // count mean something other than "one per source set".
    if (!String(url).includes("/search/bulk-upload/results")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const filters = (body.filters ?? {}) as Recorded;
    recorded.push(filters);

    if (Object.values(filters).some((val) => val.length > 1)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const slug = filters.setName?.[0];
    const numbers = slug ? (perSet[slug] ?? []) : [];
    return new Response(
      JSON.stringify(
        numbers.map((cardNo) => ({
          id: `${slug}-${cardNo}`,
          cardNo,
          players: `Player ${cardNo}`,
          setName: slug,
        })),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const SERIES_1 = "2024-topps-series-1";
const SERIES_2 = "2024-topps-series-2";

/**
 * The candidate rows as the pairing dialog receives them.
 *
 * `fetchCardChecklist` returns a count and a message; every card reaches the
 * client through `getReadyCandidates`, so that is where "did the fan-out
 * actually produce these cards" has to be asserted.
 */
async function buckets(
  t: ReturnType<typeof convexTest>,
  id: Id<"selectorOptions">,
) {
  const live = await t
    .withIdentity(ADMIN)
    .query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
  return {
    matched: live.cards.filter((c) => c.bucket === "matched"),
    bscOnly: live.cards.filter((c) => c.bucket === "bscOnly"),
    slOnly: live.cards.filter((c) => c.bucket === "slOnly"),
  };
}

/**
 * sport → year → manufacturer → setName → variantType(Base).
 *
 * `baseSlots` / `baseFacets` are what the Base row carries, which is the whole
 * variable under test.
 */
async function seedTree(
  t: ReturnType<typeof convexTest>,
  baseSlots: Record<string, string>,
  baseFacets?: Record<string, "setName" | "variantName">,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" } },
      platformSlotSeq: { bsc: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" } },
      platformSlotSeq: { bsc: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const mfrId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: { bsc: { b0: "2024-topps" } },
      platformSlotSeq: { bsc: 1 },
      parentId: mfrId,
      children: [],
      lastUpdated: Date.now(),
    });
    return await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: baseSlots },
      ...(baseFacets ? { platformFacets: { bsc: baseFacets } } : {}),
      primaryPlatformId: { bsc: "b0" },
      platformSlotSeq: { bsc: Object.keys(baseSlots).length },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

beforeEach(() => {
  slState.cards = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCardChecklist — BSC splits, NeonBinder does not (NEO-189)", () => {
  test("a Base row attached to TWO BSC setName sets fetches both", async () => {
    // THE FEATURE. BSC files 2024 Topps as Series 1 and Series 2; SportLots
    // files one set; the NB Base row has to source from both.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({ [SERIES_1]: ["1", "2"], [SERIES_2]: ["351"] }, recorded),
    );
    const t = convexTest(schema, modules);
    const baseId = await seedTree(
      t,
      { b0: "base", b1: SERIES_1, b2: SERIES_2 },
      { b1: "setName", b2: "setName" },
    );

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: baseId,
      });

    expect(result.success).toBe(true);

    // TWO requests, never one multi-value facet.
    expect(recorded).toHaveLength(2);
    expect(recorded.map((f) => f.setName)).toEqual([[SERIES_1], [SERIES_2]]);
    // The setName ancestor's own slug is OVERRIDDEN, not unioned — a
    // three-value setName facet returns nothing at all.
    expect(recorded.every((f) => !f.setName?.includes("2024-topps"))).toBe(true);
    // Scope and variant ride along on every request.
    for (const f of recorded) {
      expect(f.sport).toEqual(["baseball"]);
      expect(f.year).toEqual(["2024"]);
      expect(f.variant).toEqual(["base"]);
    }

    // All three cards, from both sets, in one checklist. Read off the
    // streamed candidates: the action returns a count and a message, and the
    // cards themselves only ever reach the client through this query.
    const { matched, bscOnly } = await buckets(t, baseId);
    const numbers = [...matched, ...bscOnly].map((c) => c.cardNumber).sort();
    expect(numbers).toEqual(["1", "2", "351"]);
  });

  test("each card is attributed to the BSC set it came from", async () => {
    // `setId` is resolved to a slot on the row at commit, so a card tagged
    // with anything the operator did not attach is unattributed and drops out
    // of source filtering. Attribution must be the slug WE queried.
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({ [SERIES_1]: ["1"], [SERIES_2]: ["351"] }, recorded),
    );
    const t = convexTest(schema, modules);
    const baseId = await seedTree(
      t,
      { b0: "base", b1: SERIES_1, b2: SERIES_2 },
      { b1: "setName", b2: "setName" },
    );

    await t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: baseId,
    });

    const { bscOnly } = await buckets(t, baseId);
    const bySetId = new Map(
      bscOnly.map((c) => [c.cardNumber, c.platformData.bsc?.setId]),
    );
    expect(bySetId.get("1")).toBe(SERIES_1);
    expect(bySetId.get("351")).toBe(SERIES_2);
  });

  test("a card number in BOTH BSC sets is reported to the operator", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      stubBsc({ [SERIES_1]: ["1", "2"], [SERIES_2]: ["2"] }, recorded),
    );
    const t = convexTest(schema, modules);
    const baseId = await seedTree(
      t,
      { b0: "base", b1: SERIES_1, b2: SERIES_2 },
      { b1: "setName", b2: "setName" },
    );

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: baseId,
      });

    // The operator picked these two sets; only they can decide whether an
    // overlap is intended. The console warning alone never reaches them.
    expect(result.message).toContain("kept the first source");
    expect(result.message).toContain("BSC: 1 card number(s)");
    expect(result.message).toContain("#2");
  });

  test("a Parallel row attached to a BSC setName set is no longer discarded", async () => {
    // `parallel` has no entry in LEVEL_TO_BSC_FACET at all, so before NEO-189
    // an id here was dropped without a trace.
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", stubBsc({ [SERIES_2]: ["1"] }, recorded));
    const t = convexTest(schema, modules);
    const baseId = await seedTree(t, { b0: "parallel" });
    const parallelId = await t.run(async (ctx) => {
      const base = (await ctx.db.get(baseId))!;
      await ctx.db.patch(baseId, { value: "Parallel" });
      return ctx.db.insert("selectorOptions", {
        level: "parallel",
        value: "Gold Foil",
        platformData: { bsc: { b0: SERIES_2 } },
        platformFacets: { bsc: { b0: "setName" } },
        platformSlotSeq: { bsc: 1 },
        parentId: base._id,
        children: [],
        lastUpdated: Date.now(),
      });
    });

    await t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: parallelId,
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].setName).toEqual([SERIES_2]);
    expect(recorded[0].variant).toEqual(["parallel"]);
  });
});

describe("fetchCardChecklist — untagged legacy slots stay inert (NEO-189)", () => {
  test("an UNTAGGED Base row queries exactly what it queried before", async () => {
    // THE COMPATIBILITY GUARANTEE. Every row attached before this change
    // carries no facet tag. `b0: "base"` is what the reconciler writes at
    // variantType level, and the fetch has always ignored it — `variant` is
    // re-derived from the display value instead. Nothing here may infer that
    // the untagged id is a setName: a wrong guess re-sources a live checklist.
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", stubBsc({ "2024-topps": ["1", "2"] }, recorded));
    const t = convexTest(schema, modules);
    const baseId = await seedTree(t, { b0: "base" });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: baseId,
      });

    expect(result.success).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      sport: ["baseball"],
      year: ["2024"],
      setName: ["2024-topps"], // the ANCESTOR's slug, untouched
      variant: ["base"],
    });
    // The untagged `base` slug never reaches setName or variantName. It only
    // appears as `variant`, which is re-derived from the display value, not
    // from the slug — the distinction the level skip exists to preserve.
    expect(recorded[0].setName).not.toContain("base");
    expect(recorded[0].variantName).toBeUndefined();
  });

  test("an untagged id sitting NEXT TO a tagged one does not become tagged", async () => {
    // Partial migration is the normal state: a row keeps its reconciler-written
    // `base` slot and gains an operator-attached Series 1. Only the tagged one
    // may reach the query.
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", stubBsc({ [SERIES_1]: ["1"] }, recorded));
    const t = convexTest(schema, modules);
    const baseId = await seedTree(
      t,
      { b0: "base", b1: SERIES_1 },
      { b1: "setName" },
    );

    await t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: baseId,
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].setName).toEqual([SERIES_1]);
  });

  test("an UNTAGGED Parallel row is still inert", async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal("fetch", stubBsc({ "2024-topps": ["1"] }, recorded));
    const t = convexTest(schema, modules);
    const variantTypeId = await seedTree(t, { b0: "parallel" });
    const parallelId = await t.run(async (ctx) => {
      await ctx.db.patch(variantTypeId, { value: "Parallel" });
      return ctx.db.insert("selectorOptions", {
        level: "parallel",
        value: "Gold Foil",
        platformData: { bsc: { b0: "gold-foil" } },
        platformSlotSeq: { bsc: 1 },
        parentId: variantTypeId,
        children: [],
        lastUpdated: Date.now(),
      });
    });

    await t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: parallelId,
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].setName).toEqual(["2024-topps"]);
    expect(recorded[0].variantName).toBeUndefined();
  });
});

describe("attachPlatformIds — the facet is stored, or deliberately absent", () => {
  test("an attach that names a facet records it on the slot", async () => {
    const t = convexTest(schema, modules);
    const baseId = await seedTree(t, { b0: "base" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.attachPlatformIds, {
        selectorOptionId: baseId,
        additions: {
          bsc: [
            { id: SERIES_1, label: "Series 1", facet: "setName" },
            { id: SERIES_2, label: "Series 2", facet: "setName" },
          ],
        },
      });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    expect(row?.platformData.bsc).toEqual({
      b0: "base",
      b1: SERIES_1,
      b2: SERIES_2,
    });
    expect(row?.platformFacets?.bsc).toEqual({ b1: "setName", b2: "setName" });
    // The reconciler-written slot is untouched — it is not retro-tagged.
    expect(row?.platformFacets?.bsc?.b0).toBeUndefined();
  });

  test("an attach with NO facet writes no tag — an older client keeps working", async () => {
    // `facet` is optional on the wire on purpose. Defaulting it would mean
    // guessing on behalf of a client that never chose, which is the same
    // inference this feature removes.
    const t = convexTest(schema, modules);
    const baseId = await seedTree(t, { b0: "base" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.attachPlatformIds, {
        selectorOptionId: baseId,
        additions: { bsc: [{ id: "gold-foil", label: "Gold Foil" }] },
      });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    expect(row?.platformData.bsc?.b1).toBe("gold-foil");
    expect(row?.platformFacets).toBeUndefined();
  });

  test("SportLots attachments never carry a facet", async () => {
    const t = convexTest(schema, modules);
    const baseId = await seedTree(t, { b0: "base" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.attachPlatformIds, {
        selectorOptionId: baseId,
        additions: { sportlots: [{ id: "884412", label: "Topps" }] },
      });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    expect(row?.platformData.sportlots).toEqual({ s0: "884412" });
    expect(row?.platformFacets).toBeUndefined();
  });

  test("detaching a slot removes its facet tag with it", async () => {
    const t = convexTest(schema, modules);
    const baseId = await seedTree(t, { b0: "base" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.attachPlatformIds, {
        selectorOptionId: baseId,
        additions: {
          bsc: [
            { id: SERIES_1, label: "Series 1", facet: "setName" },
            { id: SERIES_2, label: "Series 2", facet: "setName" },
          ],
        },
      });
    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: baseId,
        side: "bsc",
        slot: "b1",
      });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    expect(row?.platformData.bsc).toEqual({ b0: "base", b2: SERIES_2 });
    expect(row?.platformFacets?.bsc).toEqual({ b2: "setName" });
  });

  test("detaching the last tagged slot drops platformFacets entirely", async () => {
    const t = convexTest(schema, modules);
    const baseId = await seedTree(t, { b0: "base" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.attachPlatformIds, {
        selectorOptionId: baseId,
        additions: {
          bsc: [{ id: SERIES_1, label: "Series 1", facet: "setName" }],
        },
      });
    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: baseId,
        side: "bsc",
        slot: "b1",
      });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    expect(row?.platformFacets).toBeUndefined();
  });
});
