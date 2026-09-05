/**
 * NEO-239 — the seed's FIRST Base checklist commit, replayed end to end.
 *
 * `.maestro/flows/setup.yaml` asserts an exact card count for 2024 Topps
 * Chrome's Base checklist on an empty preview, and CI reported 334 where main
 * saves 335. A count assertion is the only kind of E2E check that can catch a
 * silently-lost card, and it caught one — but it cannot say WHERE, and the
 * pipeline it covers is four hops long:
 *
 *   fetchCardChecklist  (pair BSC × SL → checklistCandidates)
 *     → getReadyCandidates
 *       → resolveChecklistEntities  (unknown players/teams → review wizard)
 *         → commitCardChecklist     (rows written)
 *
 * The adapters are mocked at the action boundary here, so what is under test
 * is exactly the part CI could not localise: the PAIRING and the COMMIT, on a
 * first run with no existing rows. The fixture is the flow's real shape — 335
 * BSC cards numbered #1-#335, SportLots carrying only #1-#300 — because the
 * bug is a single row and only a realistic overlap can produce it.
 *
 * The second assertion is the wizard: CI also reported that "Confirm New
 * Players & Teams" never appeared and that every saved card needed attention,
 * which together say entity resolution produced no unknowns. That is a
 * different failure from the count and needs its own guard.
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

const ADMIN = {
  subject: "admin_first_commit",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_first_commit",
  role: "admin",
};

const SENTINEL = 1_000_000;

/** What the mocked adapters return. Set per test before the fetch. */
const mockState = vi.hoisted(() => ({
  bscCards: [] as unknown[],
  slCards: [] as unknown[],
}));

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./adapters/buysportscards")>();
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
      handler: async () => ({ success: true, cards: mockState.bscCards }),
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
      handler: async () => ({ success: true, cards: mockState.slCards }),
    }),
  };
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockState.bscCards = [];
  mockState.slCards = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BSC_TOTAL = 335;
const SL_TOTAL = 300;

/** BSC's post-adapter card shape, as `fetchCardChecklist` consumes it. */
function bscCard(n: number) {
  return {
    cardNumber: String(n),
    cardName: `Player ${n}`,
    players: [`Player ${n}`],
    teams: [`Team ${n % 30}`],
    attributes: [],
    platformRef: `bsc-${n}`,
    sourceBscSetSlug: "2024-topps-chrome",
  };
}

/** SportLots' post-adapter card shape. SL carries no structured players. */
function slCard(n: number) {
  return {
    cardNumber: String(n),
    cardName: `2024 Topps Chrome #${n} Player ${n}`,
    players: [],
    teams: [],
    attributes: [],
    platformRef: `2024 Topps Chrome #${n} Player ${n}`,
    sportlotsRef: `2024 Topps Chrome #${n} Player ${n}`,
    sourceSlSetId: "884412",
  };
}

/**
 * sport → year → manufacturer → setName → variantType(Base), linked exactly
 * the way the seed leaves it: BSC ids down the spine, a `variant`-tagged slot
 * on the Base row (what "Sync Variant Types" writes), and a SportLots set id on
 * the Base row (what BaseSetPicker writes).
 */
async function seedBaseRow(
  t: ReturnType<typeof convexTest>,
): Promise<{ sportId: Id<"selectorOptions">; baseId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: SENTINEL,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const mfrId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps Chrome",
      platformData: { bsc: { b0: "2024-topps-chrome" } },
      platformSlotSeq: { bsc: 1 },
      parentId: mfrId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const baseId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "base" }, sportlots: { s0: "884412" } },
      platformFacets: { bsc: { b0: "variant" } },
      metadata: { isBase: true },
      primaryPlatformId: { bsc: "b0", sportlots: "s0" },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
    return { sportId, baseId };
  });
}

describe("the seed's first Base commit saves every card", () => {
  test("335 BSC + 300 SL pair into 335 candidates and 335 saved rows", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { sportId, baseId } = await seedBaseRow(t);

    mockState.bscCards = Array.from({ length: BSC_TOTAL }, (_, i) =>
      bscCard(i + 1),
    );
    mockState.slCards = Array.from({ length: SL_TOTAL }, (_, i) =>
      slCard(i + 1),
    );

    // 1. FETCH — pairs the two sides and publishes checklistCandidates.
    const fetched = await asAdmin.action(
      api.selectorOptions.fetchCardChecklist,
      { selectorOptionId: baseId },
    );
    expect(fetched.success).toBe(true);
    // 300 matched + 35 BSC-only. Nothing is dropped for overlapping on a
    // number: SL covers #1-#300 and BSC covers #1-#335.
    expect(fetched.candidateCount).toBe(BSC_TOTAL);

    const live = await asAdmin.query(
      api.checklistCandidates.getReadyCandidates,
      { selectorOptionId: baseId },
    );
    expect(live.cards).toHaveLength(BSC_TOTAL);
    expect(live.cards.filter((c) => c.bucket === "matched")).toHaveLength(
      SL_TOTAL,
    );
    expect(live.cards.filter((c) => c.bucket === "bscOnly")).toHaveLength(
      BSC_TOTAL - SL_TOTAL,
    );

    const cards = live.cards.map((c) => ({
      cardNumber: c.cardNumber,
      cardName: c.cardName,
      players: c.players ?? [],
      teams: c.teams ?? [],
      attributes: c.attributes ?? [],
      platformData: c.platformData,
    }));

    // 2. RESOLVE — this is what opens the "Confirm New Players & Teams"
    // wizard. CI saw it skipped entirely, which means no unknowns came back;
    // on an empty preview EVERY name is unknown, so an empty list is the
    // symptom, not a legitimate fast path.
    const resolved = await asAdmin.action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId: baseId, sportId, cards },
    );
    expect(resolved.unknownPlayers.length).toBe(BSC_TOTAL);
    expect(resolved.unknownTeams.length).toBeGreaterThan(0);
    expect(resolved.batchId).toBeTruthy();

    // 3. COMMIT — the number the flow asserts.
    const committed = await asAdmin.action(
      api.selectorOptions.commitCardChecklist,
      { selectorOptionId: baseId, sportId, cards },
    );
    expect(committed.success).toBe(true);

    const saved = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", baseId),
        )
        .collect(),
    );
    expect(saved).toHaveLength(BSC_TOTAL);

    // …and every card number survives exactly once. A plain length check
    // passes on a fixture that lost #200 and gained a duplicate #17.
    const numbers = saved.map((r) => r.cardNumber).sort((a, b) => +a - +b);
    expect(numbers).toEqual(
      Array.from({ length: BSC_TOTAL }, (_, i) => String(i + 1)),
    );
    // The overlap really is on both sides for #1-#300 — a fixture where SL
    // paired with nothing would make the count trivially right.
    expect(
      saved.filter((r) => r.platformData?.sportlots?.ref).length,
    ).toBe(SL_TOTAL);
    expect(saved.filter((r) => r.platformData?.bsc?.ref).length).toBe(
      BSC_TOTAL,
    );
  });
});
