/**
 * NEO-339 — `selectorOptions.previewCardChecklist`, the read-only checklist
 * preview `nb_draft_set` drafts every row's Match Cards answers from.
 *
 * Pinned here, on the real 908-row 2021 Topps Heritage BSC payload
 * (`adapters/__fixtures__/bsc-heritage-2021-cards.json`, see
 * `adapters/buysportscards.heritage2021.realdata.test.ts` for provenance):
 *
 *   - the preview writes nothing — every table is compared before and after;
 *   - by row, it returns exactly the buckets `fetchCardChecklist` stages in
 *     `checklistCandidates` for the same row, card for card;
 *   - cold (no row yet), with the same ids, it returns the same buckets;
 *   - `lookupTeams` yields the teams the staged rows end up with, through the
 *     same NEO-333 decision (`chooseCandidateTeams`): a dual-team value is two
 *     teams, a known comma-bearing team ("Korea, South") stays one;
 *   - a cold id that is not a value of THIS set's own facets refuses the
 *     preview before any checklist is fetched, and a chain with no `variant`
 *     never sends BSC a checklist query (NEO-239).
 */

import fs from "node:fs";
import path from "node:path";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import {
  isBscVariationRow,
  parsePlayerAttributeTokens,
  parseVariationDescription,
} from "./adapters/buysportscards";
import { cardNumberStem } from "../lib/cards/variations";
import { splitMarketplaceTeamNames } from "./adapters/marketplaceNames";
import { normalizeTeamName } from "./teams";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo339_checklist",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo339_checklist",
  name: "Admin",
  role: "admin",
};
const SIGNED_IN = { subject: "user_neo339_checklist" };

type Card = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  teams?: string[];
  attributes?: string[];
  isVariation?: boolean;
  cardVariation?: string;
  platformRef?: string;
  sourceBscSetSlug?: string;
  sourceSlSetId?: string;
};
type Item = { value: string; platformValue: string };

const state = vi.hoisted(() => ({
  bscCards: [] as Card[],
  slCards: [] as Card[],
  bscChecklistCalls: [] as Array<Record<string, unknown>>,
  slChecklistCalls: [] as Array<Record<string, unknown>>,
  optionCalls: 0,
  variants: [] as Item[],
  variantNames: [] as Item[],
  slSets: [] as Item[],
  /** bsc ref → BSC's raw team value; the mock splits it as the adapter does. */
  teamNames: {} as Record<string, string>,
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
      returns: v.any(),
      handler: async (_ctx, args) => {
        state.bscChecklistCalls.push(args);
        return { success: true, cards: state.bscCards };
      },
    }),
    // NEO-333 shape: the raw value AND its comma split, as
    // `fetchBscCardTeamNameRaw` produces them (the real splitter).
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()) },
      returns: v.record(
        v.string(),
        v.object({ rawTeamName: v.string(), teamNames: v.array(v.string()) }),
      ),
      handler: async (
        _ctx,
        args,
      ): Promise<Record<string, { rawTeamName: string; teamNames: string[] }>> => {
        const out: Record<string, { rawTeamName: string; teamNames: string[] }> =
          {};
        for (const id of args.bscCardIds) {
          const raw = state.teamNames[id];
          if (raw) {
            out[id] = {
              rawTeamName: raw,
              teamNames: splitMarketplaceTeamNames(raw).names,
            };
          }
        }
        return out;
      },
    }),
    fetchBscSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.any(),
        platformFilters: v.optional(v.any()),
        requestId: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async (_ctx, args) => {
        state.optionCalls++;
        return {
          success: true,
          options: args.level === "variantType" ? state.variants : state.variantNames,
        };
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
      returns: v.any(),
      handler: async (_ctx, args) => {
        state.slChecklistCalls.push(args);
        return { success: true, cards: state.slCards };
      },
    }),
    fetchSportLotsSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.any(),
        platformFilters: v.optional(v.any()),
        labelContext: v.optional(v.any()),
        brandScope: v.optional(v.any()),
        requestId: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async () => {
        state.optionCalls++;
        return { success: true, options: state.slSets };
      },
    }),
  };
});

/**
 * The real Heritage rows, mapped the way `fetchBscChecklist` maps them (the
 * realdata test's mapping), plus a player name and a card ref: the fixture
 * keeps only what variation parsing reads.
 */
function heritageBscCards(): Card[] {
  const raw: Array<{
    cardNo: string;
    playerAttribute?: string;
    playerAttributeDesc?: string;
  }> = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "adapters/__fixtures__/bsc-heritage-2021-cards.json"),
      "utf8",
    ),
  );
  return raw.map((r) => {
    const attributes = parsePlayerAttributeTokens(r.playerAttribute);
    const isVariation = isBscVariationRow({
      attributes,
      playerAttributeDesc: r.playerAttributeDesc,
    });
    const parsed = parseVariationDescription(r.playerAttributeDesc);
    const stem = cardNumberStem(r.cardNo);
    return {
      cardNumber: r.cardNo,
      cardName: `Player ${stem}`,
      players: [`Player ${stem}`],
      ...(attributes.length ? { attributes } : {}),
      ...(isVariation ? { isVariation: true } : {}),
      ...(parsed?.isVariety ? { cardVariation: parsed.text } : {}),
      platformRef: `bsc-${r.cardNo}`,
      sourceBscSetSlug: "2021-topps-heritage",
    };
  });
}

/**
 * SportLots' side of the same set: every BSC parent but the last 25, three
 * SportLots-only rows, one roster disagreement, and the "Action" variations
 * filed SportLots' way (parent number, description tag).
 */
function heritageSlCards(bsc: Card[]): Card[] {
  const parents = bsc.filter((c) => !c.isVariation);
  const kept = parents.slice(0, parents.length - 25).map((c) => ({
    cardNumber: c.cardNumber,
    cardName: c.cardNumber === "7" ? "Somebody Else" : c.cardName,
    players: c.cardNumber === "7" ? ["Somebody Else"] : c.players,
    platformRef: `${c.cardNumber} ${c.cardName}`,
    sourceSlSetId: "555",
  }));
  const actions = bsc
    .filter((c) => c.isVariation && c.cardVariation === "Action")
    .map((c) => {
      const stem = cardNumberStem(c.cardNumber);
      return {
        cardNumber: stem,
        cardName: `Player ${stem}`,
        players: [`Player ${stem}`],
        isVariation: true,
        cardVariation: "Action",
        platformRef: `${stem} Player ${stem} [ VAR Action ]`,
        sourceSlSetId: "555",
      };
    });
  const slOnly = ["SL1", "SL2", "SL3"].map((n) => ({
    cardNumber: n,
    cardName: `Checklist ${n}`,
    platformRef: `${n} Checklist`,
    sourceSlSetId: "555",
  }));
  return [...kept, ...actions, ...slOnly];
}

beforeEach(() => {
  state.bscCards = heritageBscCards();
  state.slCards = heritageSlCards(state.bscCards);
  state.bscChecklistCalls = [];
  state.slChecklistCalls = [];
  state.optionCalls = 0;
  state.variants = [
    { value: "Base", platformValue: "base" },
    { value: "Insert", platformValue: "insert" },
  ];
  state.variantNames = [{ value: "Clubhouse Collection", platformValue: "clubhouse" }];
  state.slSets = [
    { value: "Topps Heritage", platformValue: "555" },
    { value: "Topps Heritage Clubhouse Collection", platformValue: "556" },
  ];
  state.teamNames = {};
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const T = 1_700_000_000_000;

async function seedSet(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: T,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2021",
      platformData: { bsc: { b0: "2021" }, sportlots: { s0: "2021" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: T,
    });
    const mfrId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: T,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Heritage",
      platformData: { bsc: { b0: "2021-topps-heritage" } },
      platformSlotSeq: { bsc: 1 },
      parentId: mfrId,
      children: [],
      lastUpdated: T,
    });
    return { sportId, setId };
  });
}

/** The Base row a mapped set carries: BSC `variant` tagged, SportLots 555. */
async function seedBase(
  t: ReturnType<typeof convexTest>,
  setId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "base" }, sportlots: { s0: "555" } },
      platformLabels: { sportlots: { s0: "Topps Heritage" } },
      platformFacets: { bsc: { b0: "variant" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      metadata: { isBase: true },
      parentId: setId,
      children: [],
      lastUpdated: T,
    }),
  );
}

/** A team in the sport, plus its alias index rows. */
async function seedTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sportId,
      lastUpdated: 1,
    }),
  );
}

async function snapshotAll(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables)) {
      out[table] = await ctx.db.query(table as "selectorOptions").collect();
    }
    return out;
  });
}

type Bucketed = { bucket: string; confidence?: number; card: unknown };

/** Order-free, undefined-free comparison form. */
function normalise(rows: Bucketed[]): string[] {
  return rows
    .map((r) => JSON.stringify(r))
    .map((s) => JSON.stringify(JSON.parse(s)))
    .sort();
}

/** What the staging path wrote, in the preview's terms. */
async function stagedBuckets(
  t: ReturnType<typeof convexTest>,
  id: Id<"selectorOptions">,
): Promise<string[]> {
  const live = await t
    .withIdentity(ADMIN)
    .query(api.checklistCandidates.getReadyCandidates, { selectorOptionId: id });
  return normalise(
    live.cards.map((c) => {
      const {
        _id: _rowId,
        stem: _stem,
        teamResolved: _teamResolved,
        bucket,
        confidence,
        ...card
      } = c;
      return {
        bucket,
        ...(bucket === "matched" ? { confidence } : {}),
        card,
      };
    }),
  );
}

type Preview = {
  matched: Array<{ card: unknown; confidence: number }>;
  bscOnly: unknown[];
  slOnly: unknown[];
};

function previewBuckets(p: Preview): string[] {
  return normalise([
    ...p.matched.map((m) => ({
      bucket: "matched",
      confidence: m.confidence,
      card: m.card,
    })),
    ...p.bscOnly.map((card) => ({ bucket: "bscOnly", card })),
    ...p.slOnly.map((card) => ({ bucket: "slOnly", card })),
  ]);
}

describe("previewCardChecklist", () => {
  test("refuses a signed-in non-admin", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const baseId = await seedBase(t, setId);
    await expect(
      t
        .withIdentity(SIGNED_IN)
        .action(api.selectorOptions.previewCardChecklist, {
          selectorOptionId: baseId,
        }),
    ).rejects.toThrow(/Admin access required/);
    expect(state.bscChecklistCalls).toHaveLength(0);
  });

  test("needs exactly one form", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const baseId = await seedBase(t, setId);
    await expect(
      t.withIdentity(ADMIN).action(api.selectorOptions.previewCardChecklist, {}),
    ).rejects.toThrow(/exactly one/);
    await expect(
      t.withIdentity(ADMIN).action(api.selectorOptions.previewCardChecklist, {
        selectorOptionId: baseId,
        cold: { setId, variantType: { bscVariantId: "base" } },
      }),
    ).rejects.toThrow(/exactly one/);
  });

  test("by row: writes nothing and returns exactly the buckets fetchCardChecklist stages", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const baseId = await seedBase(t, setId);

    const before = await snapshotAll(t);
    const preview = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        selectorOptionId: baseId,
      });
    await drainScheduled(t);
    expect(await snapshotAll(t)).toEqual(before);

    expect(preview.success).toBe(true);
    expect(preview.attachedSides).toEqual(["bsc", "sportlots"]);
    expect(preview.marketplaceCalls).toBe(2);
    // The real set, reconciled: every BSC row is in exactly one bucket.
    expect(preview.matched.length + preview.bscOnly.length).toBe(908);
    expect(preview.slOnly.length).toBeGreaterThanOrEqual(3);
    expect(
      preview.matched.some(
        (m) => (m.card as { playersConflict?: unknown }).playersConflict,
      ),
    ).toBe(true);

    const staged = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: baseId,
      });
    await drainScheduled(t);
    expect(staged.success).toBe(true);
    expect(staged.message).toBe(preview.message);
    expect(staged.candidateCount).toBe(
      preview.matched.length + preview.bscOnly.length + preview.slOnly.length,
    );
    expect(previewBuckets(preview)).toEqual(await stagedBuckets(t, baseId));
  });

  test("cold: the same ids, with no row yet, give the same buckets", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);

    const before = await snapshotAll(t);
    const cold = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        cold: {
          setId,
          variantType: { bscVariantId: "base", sportlotsIds: ["555"] },
        },
      });
    await drainScheduled(t);
    expect(await snapshotAll(t)).toEqual(before);
    expect(cold.success).toBe(true);
    // 2 to confirm the ids (BSC variants, the insert-level lists), 2 to fetch.
    expect(cold.marketplaceCalls).toBe(4);

    const baseId = await seedBase(t, setId);
    const byRow = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        selectorOptionId: baseId,
      });
    expect(previewBuckets(cold)).toEqual(previewBuckets(byRow));
    expect(cold.message).toBe(byRow.message);
  });

  test("lookupTeams gives the teams the staged rows end up with, still writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setId } = await seedSet(t);
    const baseId = await seedBase(t, setId);
    // NEO-333 — "Korea, South" is ONE team NB holds, and "Korea" exists too:
    // the whole value wins over its split. The dual-team value names no team
    // NB holds as a whole, so it is two teams.
    await seedTeam(t, sportId, "Korea, South");
    await seedTeam(t, sportId, "Korea");
    state.teamNames = {
      "bsc-1": "Boston Red Sox",
      "bsc-11b": "New York Yankees",
      "bsc-2": "Cleveland Guardians, Washington Nationals",
      "bsc-3": "Korea, South",
    };

    const before = await snapshotAll(t);
    const preview = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        selectorOptionId: baseId,
        lookupTeams: true,
      });
    await drainScheduled(t);
    expect(await snapshotAll(t)).toEqual(before);
    // `resolved` counts CARDS that came back with a team: the dual-team card
    // once.
    expect(preview.teamLookup).toEqual({
      needed: 908,
      performed: true,
      resolved: 4,
    });

    const teamsOf = (cardNumber: string) => {
      const all = [
        ...preview.matched.map((m) => m.card),
        ...preview.bscOnly,
      ] as Array<{ cardNumber: string; teams?: string[] }>;
      const hits = all.filter((c) => c.cardNumber === cardNumber);
      expect(hits).toHaveLength(1);
      return hits[0].teams;
    };
    expect(teamsOf("1")).toEqual(["Boston Red Sox"]);
    expect(teamsOf("2")).toEqual(["Cleveland Guardians", "Washington Nationals"]);
    expect(teamsOf("3")).toEqual(["Korea, South"]);

    await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, { selectorOptionId: baseId });
    await drainScheduled(t);
    expect(previewBuckets(preview)).toEqual(await stagedBuckets(t, baseId));
  });

  test("cold lookupTeams decides teams by the set's sport, the same as by row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setId } = await seedSet(t);
    await seedTeam(t, sportId, "Korea, South");
    state.teamNames = {
      "bsc-2": "Cleveland Guardians, Washington Nationals",
      "bsc-3": "Korea, South",
    };

    const before = await snapshotAll(t);
    const cold = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        cold: {
          setId,
          variantType: { bscVariantId: "base", sportlotsIds: ["555"] },
        },
        lookupTeams: true,
      });
    await drainScheduled(t);
    expect(await snapshotAll(t)).toEqual(before);
    expect(cold.teamLookup.resolved).toBe(2);

    const baseId = await seedBase(t, setId);
    const byRow = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        selectorOptionId: baseId,
        lookupTeams: true,
      });
    expect(previewBuckets(cold)).toEqual(previewBuckets(byRow));
    const korea = [...cold.matched.map((m) => m.card), ...cold.bscOnly].find(
      (c) => (c as { cardNumber: string }).cardNumber === "3",
    ) as { teams?: string[] } | undefined;
    expect(korea?.teams).toEqual(["Korea, South"]);
  });

  test("cold: a variant id that is not one of this set's variants is refused before any checklist fetch", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const res = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        cold: { setId, variantType: { bscVariantId: "someone-elses-variant" } },
      });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not one of this set's BuySportsCards variants/);
    expect(state.bscChecklistCalls).toHaveLength(0);
    expect(state.slChecklistCalls).toHaveLength(0);
  });

  test("cold: a SportLots id that is not on this set's SportLots list is refused", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const res = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        cold: {
          setId,
          variantType: { bscVariantId: "base", sportlotsIds: ["999"] },
        },
      });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/SportLots id is not one of this set's/);
    expect(state.slChecklistCalls).toHaveLength(0);
    expect(state.bscChecklistCalls).toHaveLength(0);
  });

  test("cold: an insert's variantName ids are confirmed under its variant, then scope the fetch", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const ok = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        cold: {
          setId,
          variantType: { bscVariantId: "insert" },
          insert: { bscVariantNameIds: ["clubhouse"], sportlotsIds: ["556"] },
        },
      });
    expect(ok.success).toBe(true);
    expect(state.bscChecklistCalls).toHaveLength(1);
    expect(state.bscChecklistCalls[0].facetFilters).toEqual({
      sport: ["baseball"],
      year: ["2021"],
      setName: ["2021-topps-heritage"],
      variant: ["insert"],
      variantName: ["clubhouse"],
    });

    const refused = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        cold: {
          setId,
          variantType: { bscVariantId: "insert" },
          insert: { bscVariantNameIds: ["not-in-this-set"] },
        },
      });
    expect(refused.success).toBe(false);
    expect(state.bscChecklistCalls).toHaveLength(1);
  });

  test("cold: variantName ids without their variant are refused with no marketplace call", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const res = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        cold: {
          setId,
          variantType: {},
          insert: { bscVariantNameIds: ["clubhouse"] },
        },
      });
    expect(res.success).toBe(false);
    expect(res.marketplaceCalls).toBe(0);
    expect(state.optionCalls).toBe(0);
  });

  test("cold: with no variant id BSC is never sent a checklist query (NEO-239)", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const res = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.previewCardChecklist, {
        cold: { setId, variantType: { sportlotsIds: ["555"] } },
      });
    expect(res.success).toBe(true);
    expect(state.bscChecklistCalls).toHaveLength(0);
    expect(state.slChecklistCalls).toHaveLength(1);
    expect(res.bscOnly).toEqual([]);
    expect(res.matched).toEqual([]);
  });

  test("cold: over-long and repeated id lists are refused before anything is fetched", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    await expect(
      t.withIdentity(ADMIN).action(api.selectorOptions.previewCardChecklist, {
        cold: {
          setId,
          variantType: {
            bscVariantId: "base",
            sportlotsIds: Array.from({ length: 11 }, (_, i) => `${i}`),
          },
        },
      }),
    ).rejects.toThrow(/above the 10-id limit/);
    await expect(
      t.withIdentity(ADMIN).action(api.selectorOptions.previewCardChecklist, {
        cold: { setId, variantType: { bscVariantId: "base", sportlotsIds: ["555", "555"] } },
      }),
    ).rejects.toThrow(/repeats an id/);
    expect(state.optionCalls).toBe(0);
  });
});
