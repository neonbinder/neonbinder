/**
 * NEO-496 (D9, D10) — `fetchCardChecklist` reading the set's STORED
 * checklist: with nothing pasted, the leaf's own linked sections are the
 * checklist. The checklist is a source (`sources`), so Match Cards opens on
 * one marketplace plus the checklist; with no marketplace ids at all, every
 * row is a `checklistOnly` candidate and no marketplace is asked.
 *
 * Header (adapter mocks) copied from
 * `fetchCardChecklist.publishedChecklist.test.ts`.
 */
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { setRowChecklistSections } from "./lib/publishedChecklistSections";

type BscCard = {
  cardNumber: string;
  cardName: string;
  teams?: string[];
  players?: string[];
  platformRef?: string;
};

const mockState = vi.hoisted(() => ({
  bscCards: [] as BscCard[],
  teamNamesResult: {} as Record<string, { rawTeamName: string; teamNames: string[] }>,
  teamLookupCalls: [] as string[][],
  teamLookupWaitKeys: [] as Array<string | undefined>,
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
        sourceFacet: v.optional(v.union(v.literal("setName"), v.literal("variantName"))),
        waitKey: v.optional(v.string()),
      },
      returns: v.object({
        success: v.boolean(),
        cards: v.array(v.any()),
        message: v.optional(v.string()),
        collisions: v.optional(v.array(v.any())),
      }),
      handler: async (): Promise<{ success: boolean; cards: BscCard[] }> => ({
        success: true,
        cards: mockState.bscCards,
      }),
    }),
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()), waitKey: v.optional(v.string()) },
      returns: v.array(
        v.object({
          bscCardId: v.string(),
          rawTeamName: v.string(),
          teamNames: v.array(v.string()),
          success: v.boolean(),
          skipped: v.optional(v.literal(true)),
        }),
      ),
      handler: async (_ctx, args) => {
        mockState.teamLookupCalls.push(args.bscCardIds);
        mockState.teamLookupWaitKeys.push(args.waitKey);
        return args.bscCardIds.map((bscCardId) => ({
          bscCardId,
          rawTeamName: mockState.teamNamesResult[bscCardId]?.rawTeamName ?? "",
          teamNames: mockState.teamNamesResult[bscCardId]?.teamNames ?? [],
          success: true,
        }));
      },
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
      handler: async () => ({ success: true, cards: [] }),
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_stored_496",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_stored_496",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;
type SO = Id<"selectorOptions">;
type WireRow = { number: string; players: string[]; teams: string[]; noTeam?: boolean };

beforeEach(() => {
  mockState.bscCards = [];
  mockState.teamNamesResult = {};
  mockState.teamLookupCalls = [];
  mockState.teamLookupWaitKeys = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** sport → year → set → Base (BSC ids, or none) and Insert (no ids). */
async function seedTree(t: T, opts: { baseHasIds: boolean }) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: { bsc: { b0: "baseball" } },
      platformSlotSeq: { bsc: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2025",
      platformData: { bsc: { b0: "2025" } },
      platformSlotSeq: { bsc: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Donruss",
      platformData: opts.baseHasIds ? { bsc: { b0: "2025-donruss" } } : {},
      ...(opts.baseHasIds ? { platformSlotSeq: { bsc: 1 } } : {}),
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(yearId, { children: [setId] });
    const baseId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: opts.baseHasIds ? { bsc: { b0: "base" } } : {},
      ...(opts.baseHasIds
        ? {
            platformFacets: { bsc: { b0: "variant" } },
            primaryPlatformId: { bsc: "b0" },
            platformSlotSeq: { bsc: 1 },
          }
        : {}),
      parentId: setId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setId, { children: [baseId] });
    return { setId, baseId };
  });
}

async function uploadChecklist(
  t: T,
  setId: SO,
  sections: Array<{ name: string; rows: WireRow[] }>,
) {
  const who = t.withIdentity(ADMIN_IDENTITY);
  const { checklistId } = await who.mutation(api.publishedChecklists.start, {
    setId,
    fileName: "donruss.csv",
    format: "csv",
  });
  let ordinal = 0;
  while (ordinal < sections.length) {
    // One section a batch keeps every batch under the 2,000-row cap here.
    await who.mutation(api.publishedChecklists.addSections, {
      checklistId,
      firstOrdinal: ordinal,
      sections: [sections[ordinal]],
    });
    ordinal += 1;
  }
  await who.mutation(api.publishedChecklists.finish, {
    checklistId,
    sectionCount: sections.length,
    rowCount: sections.reduce((n, s) => n + s.rows.length, 0),
  });
  return checklistId;
}

const linkSections = (t: T, rowId: SO, setId: SO, keys: string[]) =>
  t.run((ctx) =>
    setRowChecklistSections(ctx, { rowId, setId, keys, userId: ADMIN_IDENTITY.subject }),
  );

const fetchFor = (t: T, selectorOptionId: SO, extra: Record<string, unknown> = {}) =>
  t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.fetchCardChecklist, {
    selectorOptionId,
    ...extra,
  });

async function candidateRows(t: T) {
  return t.run((ctx) => ctx.db.query("checklistCandidates").collect());
}

const r = (number: string, player: string, team = "Cincinnati Reds"): WireRow => ({
  number,
  players: [player],
  teams: [team],
});

const BASE_ROWS = [r("1", "Elly De La Cruz"), r("2", "Rhett Lowder"), r("3", "Noelvi Marte")];

describe("fetchCardChecklist with the set's stored checklist (NEO-496)", () => {
  test("nothing pasted: the leaf's linked sections are the checklist, and the checklist is a source", async () => {
    const t = convexTest(schema, modules);
    const { setId, baseId } = await seedTree(t, { baseHasIds: true });
    await uploadChecklist(t, setId, [
      { name: "Base", rows: BASE_ROWS },
      { name: "Rated Rookies", rows: [r("201", "Somebody Else")] },
    ]);
    await linkSections(t, baseId, setId, ["base"]);
    mockState.bscCards = [
      { cardNumber: "1", cardName: "Elly De La Cruz", players: ["Elly De La Cruz"], platformRef: "bsc-1" },
      { cardNumber: "2", cardName: "Rhett Lowder", players: ["Rhett Lowder"], platformRef: "bsc-2" },
    ];

    const result = await fetchFor(t, baseId);

    expect(result.success).toBe(true);
    expect(result.sources).toEqual(["bsc", "checklist"]);
    expect(result.checklist).toEqual({ source: "stored", rowCount: 3, sectionKeys: ["base"] });
    // Teams come from the checklist: no BSC card-listing lookup.
    expect(mockState.teamLookupCalls).toEqual([]);
    const rows = await candidateRows(t);
    const byNumber = new Map(rows.map((c) => [c.cardNumber, c]));
    expect(byNumber.get("1")).toMatchObject({
      teams: ["Cincinnati Reds"],
      teamLookup: "checklist",
      checklistLink: { via: "number" },
    });
    // Row 3 no card paired: its own checklist-only candidate, no refs.
    expect(byNumber.get("3")).toMatchObject({
      bucket: "checklistOnly",
      cardName: "Noelvi Marte",
      platformData: {},
      teams: ["Cincinnati Reds"],
      teamLookup: "checklist",
    });
    // Only the linked section was read: Rated Rookies' card is nowhere.
    expect(byNumber.has("201")).toBe(false);
    expect(result.checklistMatch?.checklistOnlyCount).toBe(1);
  });

  test("a pasted checklist wins over the stored one", async () => {
    const t = convexTest(schema, modules);
    const { setId, baseId } = await seedTree(t, { baseHasIds: true });
    await uploadChecklist(t, setId, [{ name: "Base", rows: BASE_ROWS }]);
    await linkSections(t, baseId, setId, ["base"]);
    mockState.bscCards = [
      { cardNumber: "1", cardName: "Elly De La Cruz", players: ["Elly De La Cruz"], platformRef: "bsc-1" },
    ];

    const result = await fetchFor(t, baseId, {
      publishedChecklist: { rows: [r("1", "Elly De La Cruz", "Louisville Bats")] },
    });

    expect(result.checklist).toEqual({ source: "paste", rowCount: 1 });
    expect(result.sources).toEqual(["bsc", "checklist"]);
    const rows = await candidateRows(t);
    expect(rows.map((c) => c.cardNumber)).toEqual(["1"]);
    expect(rows[0].teams).toEqual(["Louisville Bats"]);
  });

  test("a leaf with no linked sections reads no checklist: one source, as before", async () => {
    const t = convexTest(schema, modules);
    const { setId, baseId } = await seedTree(t, { baseHasIds: true });
    await uploadChecklist(t, setId, [{ name: "Base", rows: BASE_ROWS }]);
    mockState.bscCards = [
      { cardNumber: "1", cardName: "Elly De La Cruz", players: ["Elly De La Cruz"], platformRef: "bsc-1" },
    ];

    const result = await fetchFor(t, baseId);

    expect(result.sources).toEqual(["bsc"]);
    expect(result.checklist).toBeUndefined();
    expect((await candidateRows(t)).map((c) => c.bucket)).toEqual(["bscOnly"]);
  });

  test("linked sections too big to read: fetched without them, and the result says so", async () => {
    const t = convexTest(schema, modules);
    const { setId, baseId } = await seedTree(t, { baseHasIds: true });
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => r(`${prefix}${i + 1}`, `Player ${prefix}${i + 1}`));
    await uploadChecklist(t, setId, [
      { name: "Base", rows: many("", 1_500) },
      { name: "Base Red", rows: many("R", 600) },
    ]);
    await linkSections(t, baseId, setId, ["base", "base red"]);
    mockState.bscCards = [
      { cardNumber: "1", cardName: "Player 1", players: ["Player 1"], platformRef: "bsc-1" },
    ];

    const result = await fetchFor(t, baseId);

    expect(result.success).toBe(true);
    expect(result.sources).toEqual(["bsc"]);
    expect(result.checklist).toMatchObject({
      source: "stored",
      rowCount: 0,
      skippedOverCap: { rowCount: 2_100, byteSize: expect.any(Number) },
    });
    expect((await candidateRows(t)).map((c) => c.bucket)).toEqual(["bscOnly"]);
  });

  test("no marketplace ids + a stored checklist: no marketplace is asked, every row is checklist-only", async () => {
    const t = convexTest(schema, modules);
    const { setId, baseId } = await seedTree(t, { baseHasIds: false });
    await uploadChecklist(t, setId, [{ name: "Base", rows: [...BASE_ROWS, { number: "4", players: ["Nobody"], teams: [] }] }]);
    await linkSections(t, baseId, setId, ["base"]);
    mockState.bscCards = [
      { cardNumber: "1", cardName: "Should Not Be Read", platformRef: "bsc-1" },
    ];

    const result = await fetchFor(t, baseId);

    expect(result.success).toBe(true);
    expect(result.sources).toEqual(["checklist"]);
    expect(result.attachedSides).toEqual([]);
    expect(result.candidateCount).toBe(4);
    const rows = await candidateRows(t);
    expect(new Set(rows.map((c) => c.bucket))).toEqual(new Set(["checklistOnly"]));
    expect(rows.every((c) => Object.keys(c.platformData ?? {}).length === 0)).toBe(true);
    // A row naming no team gets no team and no lookup: the operator picks.
    const four = rows.find((c) => c.cardNumber === "4");
    expect(four?.teams).toBeUndefined();
    expect(four?.teamLookup).toBeUndefined();
    expect(mockState.teamLookupCalls).toEqual([]);
  });

  test("no marketplace ids and no checklist: the early return, now carrying sources []", async () => {
    const t = convexTest(schema, modules);
    const { baseId } = await seedTree(t, { baseHasIds: false });

    const result = await fetchFor(t, baseId);

    expect(result.success).toBe(true);
    expect(result.candidateCount).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.checklist).toBeUndefined();
  });
});
