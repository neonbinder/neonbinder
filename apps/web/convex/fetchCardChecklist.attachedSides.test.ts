/**
 * NEO-255 — `fetchCardChecklist` reports which marketplaces are ATTACHED.
 *
 * The client skips the Match Cards dialog when exactly one is attached: there
 * is no second column and nothing to line up, so every fetched card is kept as
 * a single and the run carries on as if Confirm had been pressed. That is a
 * silent commit, so the value it turns on has to be reported by the side that
 * read the slots — and it has to be reported the SAME WAY however the run went.
 *
 * Which is what these tests are about. `attachedSides` is derived from slot
 * data alone (`attachedSidesOf`), never from `resolution` and never from how
 * many cards came back, and the case that proves the difference is a
 * two-marketplace set where one adapter falls over: it returns no cards, it
 * returns them on a `success: true` result indistinguishable from an empty
 * side, and it is still attached. If attachment tracked either of those
 * downstream signals, an outage would auto-commit a two-sided set as one-sided
 * with nobody looking at it.
 *
 * Adapter mocking follows `convex/fetchCardChecklist.nameConflict.test.ts` —
 * both marketplaces are module-mocked, so nothing here can reach a live
 * marketplace (NEO-247).
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { NO_MARKETPLACE_IDS_MESSAGE } from "./marketplaceResolvability";
import { MAX_PLAYER_NAME_LENGTH } from "../lib/players/name-limits";

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
        collisions: v.optional(v.array(v.any())),
      }),
      handler: async () => {
        if (mockState.bscThrows) throw new Error("BuySportsCards is down");
        return { success: true, cards: mockState.bscCards };
      },
    }),
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()) },
      returns: v.record(v.string(), v.string()),
      handler: async (): Promise<Record<string, string>> => ({}),
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
      handler: async () => {
        if (mockState.slThrows) throw new Error("SportLots is down");
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

beforeEach(() => {
  mockState.bscCards = [];
  mockState.slCards = [];
  mockState.bscThrows = false;
  mockState.slThrows = false;
});

describe("fetchCardChecklist — attachedSides on the SUCCESS return", () => {
  test("both marketplaces attached come back as two sides", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscCards = [bscCard("1")];
    mockState.slCards = [slCard("2")];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    expect(result.attachedSides).toEqual(["bsc", "sportlots"]);
    expect(result.candidateCount).toBe(2);
  });

  test("a SportLots-only set reports one side", async () => {
    // The shape the whole ticket is for: NB's own set, linked to SportLots and
    // nothing else. There is no BSC column for the operator to line these up
    // against, so the client keeps them all.
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: false, slSet: true });
    mockState.slCards = [slCard("1"), slCard("2")];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    expect(result.attachedSides).toEqual(["sportlots"]);
    expect(result.candidateCount).toBe(2);
  });

  test("a BSC-only set reports one side", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: false });
    mockState.bscCards = [bscCard("1"), bscCard("2"), bscCard("3")];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    expect(result.attachedSides).toEqual(["bsc"]);
    expect(result.candidateCount).toBe(3);
  });

  test("sport and year ids alone attach nothing", async () => {
    // Both sides' SCOPE ids are on the chain and neither set link is. The
    // fetch still runs (SportLots is scopable by sport+year) and comes back
    // with nothing, because the adapter has no set to ask about — and the
    // answer to "which marketplaces is this set on" is still none.
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: false, slSet: false });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.attachedSides).toEqual([]);
  });
});

describe("fetchCardChecklist — an adapter falling over does not change attachment", () => {
  test("BSC throws and the set is still reported as two-sided", async () => {
    // THE case this field exists to get right. `fetchBsc` catches its own
    // failure and hands back an empty side, so a BSC outage is on the wire as
    // "0 BSC-only" — indistinguishable from a set BSC does not carry. Keying
    // the dialog on cards, or on `resolution`, would let that outage
    // auto-commit a two-marketplace set as a one-sided one.
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscThrows = true;
    mockState.slCards = [slCard("1"), slCard("2")];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    // Not one side. The BSC id is still attached to the set.
    expect(result.attachedSides).toEqual(["bsc", "sportlots"]);
    // And the run really did come back with only SportLots' rows, which is the
    // half that would have fooled a count-based rule.
    expect(result.message).toContain("0 BSC-only");
    expect(result.candidateCount).toBe(2);
  });

  test("SportLots throws and the set is still reported as two-sided", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.slThrows = true;
    mockState.bscCards = [bscCard("1")];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    expect(result.attachedSides).toEqual(["bsc", "sportlots"]);
    expect(result.message).toContain("0 SL-only");
  });

  test("both throw and the set is still reported as two-sided", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscThrows = true;
    mockState.slThrows = true;

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.attachedSides).toEqual(["bsc", "sportlots"]);
    // Nothing published, so the client short-circuits on the count anyway —
    // but it is told the truth about the mapping either way.
    expect(result.candidateCount).toBe(0);
  });

  test("an ATTACHED but unscopable BSC side still counts as attached", async () => {
    // The `variant` tag is stripped, so `resolvableSides` skips BSC entirely
    // and no BSC request goes out. The BSC set is still linked to this row,
    // the dialog still opens, and its BSC column is empty — exactly as today.
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    await t.run(async (ctx) =>
      ctx.db.patch(rowId, { platformData: { sportlots: { s0: "189991" } } }),
    );
    mockState.slCards = [slCard("1")];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    expect(result.attachedSides).toEqual(["bsc", "sportlots"]);
  });
});

describe("fetchCardChecklist — attachedSides on the other two returns", () => {
  test("the zero-candidate return carries it", async () => {
    // A path with no marketplace ids at all: neither side is scopable, so the
    // action short-circuits before publishing anything. The field is still
    // there, and honestly empty.
    const t = convexTest(schema, modules);
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        sportConfig: { skuCode: "BB", league: "MLB" },
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    expect(result.message).toBe(NO_MARKETPLACE_IDS_MESSAGE);
    expect(result.candidateCount).toBe(0);
    expect(result.attachedSides).toEqual([]);
  });

  test("the FAILURE return carries the real sides, not an empty list", async () => {
    // A throw that lands after the chain has been read — here an over-length
    // player name, which `startCandidateBatch` refuses. The run fails, and the
    // set is still attached to both marketplaces; answering `[]` would tell
    // the client a two-sided set is one-sided at the exact moment it has the
    // least evidence to check.
    const t = convexTest(schema, modules);
    const rowId = await seedTree(t, { bscSet: true, slSet: true });
    mockState.bscCards = [
      { ...bscCard("1"), players: ["N".repeat(MAX_PLAYER_NAME_LENGTH + 1)] },
    ];

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to fetch checklist");
    expect(result.candidateCount).toBe(0);
    expect(result.attachedSides).toEqual(["bsc", "sportlots"]);
  });
});
