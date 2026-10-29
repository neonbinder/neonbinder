/**
 * NEO-387 — a marketplace side that was asked and FAILED is never read as a
 * side with no cards.
 *
 * Found in E2E during the NEO-385 Secret Manager quota bursts: the BSC token
 * read 500'd, `fetchBscChecklist` answered `success: false` (no_sign_in), and
 * `fetchCardChecklist` turned that into an empty side. On a BSC-only set the
 * run then reported success with 0 candidates, the client saved an empty
 * checklist ("Saved 0 cards."), and a refresh called every existing card "no
 * longer listed upstream". The screen showed no error at all.
 *
 * Adapter mocking follows `fetchCardChecklist.attachedSides.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

type Card = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  platformRef?: string;
  sourceBscSetSlug?: string;
  sourceSlSetId?: string;
};

const mockState = vi.hoisted(() => ({
  bscCards: [] as Card[],
  slCards: [] as Card[],
  /** When set, that adapter throws instead of answering. */
  bscThrows: false,
  slThrows: false,
  /** When set, that adapter answers `success: false` the way the real one does. */
  bscFails: null as null | { message: string; failure?: { kind: string; timedOut: boolean } },
  slFails: null as null | { message: string },
  slCalls: [] as Array<Record<string, string>>,
}));

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action, internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        facetFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        sourceFacet: v.optional(
          v.union(v.literal("setName"), v.literal("variantName")),
        ),
      },
      returns: v.object({
        success: v.boolean(),
        cards: v.array(v.any()),
        message: v.optional(v.string()),
        failure: v.optional(v.any()),
        collisions: v.optional(v.array(v.any())),
      }),
      handler: async () => {
        if (mockState.bscThrows) throw new Error("BuySportsCards is down");
        if (mockState.bscFails) return { success: false, cards: [], ...mockState.bscFails };
        return { success: true, cards: mockState.bscCards };
      },
    }),
    // NEO-335: one entry per requested id; an empty list reads as every
    // lookup failed, which the caller treats exactly as "no team" before.
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()) },
      returns: v.array(
        v.object({
          bscCardId: v.string(),
          teamName: v.string(),
          success: v.boolean(),
        }),
      ),
      handler: async () => [],
    }),
  };
});

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
      handler: async (_ctx, args) => {
        mockState.slCalls.push(args.platformFilters ?? {});
        if (mockState.slThrows) throw new Error("SportLots is down");
        if (mockState.slFails) return { success: false, cards: [], ...mockState.slFails };
        return { success: true, cards: mockState.slCards };
      },
    }),
  };
});

// convex-test v0.0.53 with Vitest uses import.meta.glob to discover modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_255",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_255",
  name: "Admin",
  role: "admin",
};

/**
 * A four-level chain, with each side's SET link switchable.
 *
 * `sport` and `year` always carry both marketplaces' ids: those are query
 * SCOPE — SportLots' `sprt`/`yr` and BSC's own two facets — and every real
 * chain has them. They are exactly what must NOT make a set look attached, so
 * they stay on even in the fixtures that expect one side or none.
 */
async function seedTree(
  t: ReturnType<typeof convexTest>,
  opts: { bscSet: boolean; slSet: boolean },
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2021",
      platformData: { bsc: { b0: "2021" }, sportlots: { s0: "2021" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      // The BSC set link. Untagged, which is the ordinary synced shape: the
      // level rule resolves a setName row's slug to the `setName` facet.
      platformData: opts.bscSet ? { bsc: { b0: "topps" } } : {},
      ...(opts.bscSet ? { platformSlotSeq: { bsc: 1 } } : {}),
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    return await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {
        // `variant` is query scope for BSC, and mandatory for a checklist
        // fetch — it is carried whenever the BSC set is, so the BSC side is
        // resolvable rather than merely attached.
        ...(opts.bscSet ? { bsc: { b0: "base" } } : {}),
        // SportLots has no setName level: its one flat set id lives here.
        ...(opts.slSet ? { sportlots: { s0: "189991" } } : {}),
      },
      ...(opts.bscSet ? { platformFacets: { bsc: { b0: "variant" } } } : {}),
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

/** A card each marketplace lists on its own number, so nothing auto-matches. */
function bscCard(n: string): Card {
  return {
    cardNumber: n,
    cardName: `BSC Card ${n}`,
    platformRef: `bsc-${n}`,
    sourceBscSetSlug: "topps",
  };
}

function slCard(n: string): Card {
  return {
    cardNumber: n,
    cardName: `SL Card ${n}`,
    platformRef: `2021 Topps #${n}`,
    sourceSlSetId: "189991",
  };
}


const NOTHING_CHANGED = /nothing changed — try again in a bit/;

beforeEach(() => {
  mockState.bscCards = [];
  mockState.slCards = [];
  mockState.bscThrows = false;
  mockState.slThrows = false;
  mockState.bscFails = null;
  mockState.slFails = null;
  mockState.slCalls = [];
});

afterEach(() => {
  delete process.env.NEONBINDER_PAUSED_PLATFORMS;
});

async function fetchFor(t: ReturnType<typeof convexTest>, rowId: Id<"selectorOptions">) {
  return t.withIdentity(ADMIN).action(api.selectorOptions.fetchCardChecklist, {
    selectorOptionId: rowId,
  });
}

async function candidateRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("checklistCandidates").collect());
}

describe("fetchCardChecklist — every asked side failed: the run fails (NEO-387)", () => {
  test("a BSC-only set whose BSC sign-in failed reports the failure, not 0 cards", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: false });
    // The real adapter's answer when getBscToken came back empty.
    mockState.bscFails = {
      message: "No BSC token available. Connect your BSC account first.",
      failure: { kind: "no_sign_in", timedOut: false },
    };

    const result = await fetchFor(t, rowId);

    // SportLots was asked on its sport/year scope and answered with nothing,
    // which must not turn the BSC failure back into "Saved 0 cards.".
    expect(mockState.slCalls.length).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    expect(result.candidateCount).toBe(0);
    expect(result.message).toBe(
      "we couldn't sign in to BSC, so nothing changed — try again in a bit",
    );
    // Nothing reached the operator's candidate stream.
    expect(await candidateRows(t)).toHaveLength(0);
    // Attachment is still reported truthfully on the failure return.
    expect(result.attachedSides).toEqual(["bsc"]);
  });

  test("a BSC failure with no structured reason still fails, read off its message", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: false });
    mockState.bscFails = { message: "BSC error: fetch failed" };

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/^BSC couldn't be reached, /);
    expect(result.message).toMatch(NOTHING_CHANGED);
  });

  test("BSC throwing (caught into success: false) on a BSC-only set fails the run", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: false });
    mockState.bscThrows = true;

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/^BSC /);
    expect(result.message).toMatch(NOTHING_CHANGED);
  });

  test("a SportLots-only set whose fetch failed fails the run", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: false, slSet: true });
    mockState.slFails = { message: "SportLots error: HTTP error 503" };

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots answered with an error, so nothing changed — try again in a bit",
    );
  });

  test("both sides failing names both", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscFails = { message: "x", failure: { kind: "no_sign_in", timedOut: false } };
    mockState.slThrows = true;

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/BSC/);
    expect(result.message).toMatch(/SportLots/);
    expect(result.attachedSides).toEqual(["bsc", "sportlots"]);
  });

  test("with SportLots paused, a BSC failure is every asked side and fails the run", async () => {
    // The exact E2E shape: SportLots paused, so BSC was the only side asked.
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscFails = { message: "x", failure: { kind: "no_sign_in", timedOut: false } };
    mockState.slCards = [slCard("1")];

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(NOTHING_CHANGED);
    expect(result.pausedSides).toEqual(["sportlots"]);
  });
});

describe("fetchCardChecklist — one of two sides failed: the run goes on and says so (NEO-387)", () => {
  test("BSC failed, SportLots answered: SportLots' cards come through, the line names BSC", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscFails = { message: "x", failure: { kind: "no_sign_in", timedOut: false } };
    mockState.slCards = [slCard("1"), slCard("2")];

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(true);
    expect(result.candidateCount).toBe(2);
    expect(result.message).toContain(
      "We couldn't sign in to BSC, so its cards are missing from this run.",
    );
    // Still two-sided, so the Match Cards dialog opens rather than auto-committing.
    expect(result.attachedSides).toEqual(["bsc", "sportlots"]);
  });

  test("SportLots threw (caught into a failed call), BSC answered: the line names SportLots", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.slThrows = true;
    mockState.bscCards = [bscCard("1")];

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.message).toMatch(/SportLots .*, so its cards are missing from this run\.$/);
  });

  test("a healthy run carries no missing-side sentence", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscCards = [bscCard("1")];
    mockState.slCards = [slCard("2")];

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(true);
    expect(result.message).not.toMatch(/missing from this run/);
  });

  test("a side that answered with no cards is NOT a failure", async () => {
    // An empty answer is a real answer; only success: false is a failure.
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: false });
    mockState.bscCards = [];

    const result = await fetchFor(t, rowId);

    expect(result.success).toBe(true);
    expect(result.candidateCount).toBe(0);
    expect(result.message).not.toMatch(/missing from this run|nothing changed/);
  });
});

