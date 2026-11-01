/**
 * NEO-312 × NEO-313 — the parallel build keeps the derived player index
 * (`cardPlayerLinks`) in step with the cards it writes.
 *
 * The build is the second writer of new cards (through `insertCardRow`) and a
 * bulk deleter of old ones (`deleteParallelCardsPage`). Either one out of step
 * with the index is a silent data bug: a copy with no index row is missing
 * from the Players admin card list, and an index row left behind by a rebuild
 * names a card that no longer exists.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo312_links",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo312_links",
  role: "admin",
};

const SENTINEL = 1_700_000_000_000;

type StubCard = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  platformRef: string;
  sourceBscSetSlug?: string;
};

const bscState = vi.hoisted(() => ({ cards: [] as StubCard[] }));
vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        facetFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        sourceFacet: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async () => ({ success: true, cards: bscState.cards }),
    }),
  };
});

beforeEach(() => {
  bscState.cards = [];
});

type T = ReturnType<typeof convexTest>;

/**
 * sport → year → setName → variantType(Insert) → insert(Anime) →
 * parallel(Anime Kanji, BSC only), plus two players and two insert cards
 * carrying them. BSC only, so no SportLots stub is needed.
 */
async function seed(t: T) {
  return t.run(async (ctx) => {
    const mk = (
      level: "sport" | "year" | "setName" | "variantType" | "insert" | "parallel",
      value: string,
      parentId: Id<"selectorOptions"> | undefined,
      platformData: { bsc?: Record<string, string> },
      extra: { platformFacets?: { bsc: Record<string, "variant" | "variantName"> } } = {},
    ) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        ...(parentId ? { parentId } : {}),
        platformData,
        children: [],
        lastUpdated: SENTINEL,
        ...extra,
      });
    const sport = await mk("sport", "Baseball", undefined, { bsc: { b0: "baseball" } });
    const year = await mk("year", "2024", sport, { bsc: { b0: "2024" } });
    const setName = await mk("setName", "Bowman", year, { bsc: { b0: "bowman" } });
    const variantType = await mk("variantType", "Insert", setName, { bsc: { b0: "insert" } }, {
      platformFacets: { bsc: { b0: "variant" } },
    });
    const insert = await mk("insert", "Anime", variantType, { bsc: { b0: "anime" } });
    const parallel = await mk("parallel", "Anime Kanji", insert, { bsc: { b0: "anime-kanji" } }, {
      platformFacets: { bsc: { b0: "variantName" } },
    });

    const player = async (name: string) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: name.toLowerCase(),
        sportId: sport,
        lastUpdated: SENTINEL,
      });
    const ohtani = await player("Shohei Ohtani");
    const judge = await player("Aaron Judge");
    const card = (n: string, p: Id<"players">, name: string, sortOrder: number) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: insert,
        cardNumber: n,
        cardName: name,
        playerIds: [p],
        playerLinks: [{ playerId: p, nameOnCard: name }],
        platformData: { bsc: { ref: `ins-${n}`, src: "b0" } },
        sortOrder,
        lastUpdated: SENTINEL,
      });
    await card("1", ohtani, "Shohei Ohtani", 1);
    await card("2", judge, "Aaron Judge", 2);
    return { sport, insert, parallel, ohtani, judge };
  });
}

function kanjiCards(): StubCard[] {
  return [
    { cardNumber: "1", cardName: "Shohei Ohtani", players: ["Shohei Ohtani"], platformRef: "k-1", sourceBscSetSlug: "anime-kanji" },
    { cardNumber: "2", cardName: "Aaron Judge", players: ["Aaron Judge"], platformRef: "k-2", sourceBscSetSlug: "anime-kanji" },
  ];
}

async function linksState(t: T, parallel: Id<"selectorOptions">) {
  return t.run(async (ctx) => {
    const cards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", parallel))
      .collect();
    const links = await ctx.db.query("cardPlayerLinks").collect();
    const cardIds = new Set<string>(cards.map((c) => c._id));
    return {
      cards,
      linksOnParallel: links.filter((l) => cardIds.has(l.cardChecklistId)),
      // A link whose card no longer exists anywhere.
      orphans: (
        await Promise.all(links.map(async (l) => ((await ctx.db.get(l.cardChecklistId)) ? null : l)))
      ).filter((l) => l !== null),
    };
  });
}

describe("parallel build — the derived player index (NEO-313)", () => {
  test("every copy is indexed with its players, keyed by the parallel's sport", async () => {
    const t = convexTest(schema, modules);
    const { sport, parallel, ohtani, judge } = await seed(t);
    bscState.cards = kanjiCards();

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: parallel });
    expect(result.status).toBe("built");
    expect(result.copied).toBe(2);

    const { cards, linksOnParallel } = await linksState(t, parallel);
    expect(cards).toHaveLength(2);
    // One row per (copy, player), and nothing else.
    expect(linksOnParallel).toHaveLength(2);
    for (const card of cards) {
      const rows = linksOnParallel.filter((l) => l.cardChecklistId === card._id);
      expect(rows.map((r) => r.playerId)).toEqual(card.playerIds);
      expect(rows.every((r) => r.sportId === sport)).toBe(true);
    }
    expect(new Set(linksOnParallel.map((l) => l.playerId))).toEqual(new Set([ohtani, judge]));
  });

  test("a rebuild leaves no orphan index rows and indexes the new copies", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    bscState.cards = kanjiCards();

    await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: parallel });
    const before = await linksState(t, parallel);
    expect(before.linksOnParallel).toHaveLength(2);

    const rebuilt = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: parallel });
    expect(rebuilt.status).toBe("built");
    expect(rebuilt.rebuilt).toBe(true);

    const after = await linksState(t, parallel);
    // The old copies are gone, and so is every index row that named them.
    const oldIds = new Set<string>(before.cards.map((c) => c._id));
    expect(after.cards.some((c) => oldIds.has(c._id))).toBe(false);
    expect(after.orphans).toEqual([]);
    // The new copies are indexed, once each.
    expect(after.linksOnParallel).toHaveLength(2);
    for (const card of after.cards) {
      expect(after.linksOnParallel.filter((l) => l.cardChecklistId === card._id)).toHaveLength(1);
    }
  });
});
