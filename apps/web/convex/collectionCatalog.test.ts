/**
 * NEO-358 — the collector's catalog reads (`convex/collectionCatalog.ts`).
 *
 * Covers the drill order, a set's summary with both card counts, a variant's
 * checklist, card hydration, suggestions (player alias, team, set), the free
 * text search's terms-vs-phrase rule, player and team (franchise) card lists,
 * and the NB-only guarantee: no result carries a marketplace or `isCustom` /
 * `sku` key even though every fixture row has them. Also (Jason, 2026-10-24)
 * that a row KNOWN to hold no cards beneath it is hidden from the drill, the
 * set summary and set suggestions, while an uncounted row is shown; and
 * (NEO-364, 2026-10-25) that a sport, year or brand is shown only when it
 * carries `hasCards`.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = { subject: "collector_catalog_001" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, as: t.withIdentity(USER) };
}

/**
 * Keys that may never reach a collector. Checked against the JSON text of a
 * result, so a nested object leaking through is caught as well.
 */
const FORBIDDEN_KEYS = [
  "platformData",
  "platformLabels",
  "platformFacets",
  "primaryPlatformId",
  "platformSlotSeq",
  "isCustom",
  "sku",
  "bscTeamName",
  "pendingTeamNames",
  "pendingPlayerNames",
  "attributes",
  "autographType",
];

function expectNbOnly(result: unknown) {
  const text = JSON.stringify(result);
  for (const key of FORBIDDEN_KEYS) {
    expect(text, `result leaked "${key}"`).not.toContain(`"${key}"`);
  }
  // Values too: no slug, ref, label or SKU from the fixture's residue.
  expect(text).not.toMatch(/bsc-slug|bsc-ref|BSC label|SKU-|BSC Team|Pending|platform-attr/i);
}

describe("auth", () => {
  test("every catalog read refuses a signed-out caller", async () => {
    const { t, fx } = await setup();
    const calls: Array<() => Promise<unknown>> = [
      () => t.query(api.collectionCatalog.drill, {}),
      () => t.query(api.collectionCatalog.setPath, { setId: fx.setId }),
      () => t.query(api.collectionCatalog.setSummary, { setId: fx.setId }),
      () => t.query(api.collectionCatalog.variantCards, { variantId: fx.baseId }),
      () => t.query(api.collectionCatalog.card, { cardId: fx.gooden1 }),
      () => t.query(api.collectionCatalog.cards, { cardIds: [fx.gooden1] }),
      () => t.query(api.collectionCatalog.suggest, { q: "Gooden" }),
      () => t.query(api.collectionCatalog.search, { q: "Gooden" }),
      () => t.query(api.collectionCatalog.cardsByPlayer, { playerId: fx.goodenId }),
      () => t.query(api.collectionCatalog.cardsByTeam, { teamId: fx.metsId }),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(/Not authenticated/);
  });
});

describe("NB data only", () => {
  test("no catalog result carries a marketplace, isCustom or sku key", async () => {
    const { as, fx } = await setup();
    const results = [
      await as.query(api.collectionCatalog.drill, {}),
      await as.query(api.collectionCatalog.drill, { parentId: fx.setId }),
      await as.query(api.collectionCatalog.drill, { level: "insert", parentId: fx.insertsTypeId }),
      await as.query(api.collectionCatalog.setPath, { setId: fx.setId }),
      await as.query(api.collectionCatalog.setSummary, { setId: fx.setId }),
      await as.query(api.collectionCatalog.variantCards, { variantId: fx.baseId }),
      await as.query(api.collectionCatalog.card, { cardId: fx.gooden1 }),
      await as.query(api.collectionCatalog.cards, { cardIds: [fx.gooden1, fx.gold1, "nope"] }),
      await as.query(api.collectionCatalog.suggest, { q: "Gooden" }),
      await as.query(api.collectionCatalog.suggest, { q: "2024 Topps Chrome" }),
      await as.query(api.collectionCatalog.suggest, { q: "Mets" }),
      await as.query(api.collectionCatalog.search, { q: "Gooden" }),
      await as.query(api.collectionCatalog.cardsByPlayer, { playerId: fx.goodenId }),
      await as.query(api.collectionCatalog.cardsByTeam, { teamId: fx.exposId, includeFranchise: true }),
    ];
    for (const result of results) {
      expect(result).not.toBeNull();
      expectNbOnly(result);
    }
  });
});

describe("drill", () => {
  test("sports at the root, years newest first, variant types Base → Insert → Parallel", async () => {
    const { as, fx } = await setup();
    const sports = await as.query(api.collectionCatalog.drill, {});
    expect(sports.items.map((i) => i.name)).toEqual(["Baseball"]);

    const years = await as.query(api.collectionCatalog.drill, { level: "year", parentId: fx.sportId });
    expect(years.items.map((i) => i.name)).toEqual(["2024", "1986"]);

    const types = await as.query(api.collectionCatalog.drill, { parentId: fx.setId });
    expect(types.items.map((i) => [i.name, i.kind, i.cardCount, i.baseCardCount])).toEqual([
      ["Base", "base", 3, 2],
      ["Inserts", "insert", 0, 0],
      ["Parallels", "parallel", 0, 0],
    ]);
  });

  test("an uncounted row is counted by hand, both ways", async () => {
    const { as, fx } = await setup();
    const inserts = await as.query(api.collectionCatalog.drill, {
      level: "insert",
      parentId: fx.insertsTypeId,
    });
    expect(inserts.items).toEqual([
      expect.objectContaining({ name: "Future Stars", cardCount: 1, baseCardCount: 1, kind: null }),
    ]);
  });

  test("a bad parent id is an empty column, not a throw", async () => {
    const { as } = await setup();
    expect(await as.query(api.collectionCatalog.drill, { parentId: "not-an-id" })).toEqual({
      items: [],
      truncated: false,
    });
  });
});

describe("a set", () => {
  test("setPath names the set's sport, year and brand", async () => {
    const { as, fx } = await setup();
    expect(await as.query(api.collectionCatalog.setPath, { setId: fx.setId })).toEqual({
      _id: fx.setId,
      name: "Topps Chrome",
      season: "2024",
      sport: { _id: fx.sportId, name: "Baseball" },
      year: { _id: fx.yearId, name: "2024" },
      manufacturer: { _id: fx.toppsId, name: "Topps" },
    });
    // Not a set row, or not an id at all: null.
    expect(await as.query(api.collectionCatalog.setPath, { setId: fx.baseId })).toBeNull();
    expect(await as.query(api.collectionCatalog.setPath, { setId: "zzz" })).toBeNull();
  });

  test("setSummary lists every card-bearing row in checklist order with both counts", async () => {
    const { as, fx } = await setup();
    const summary = await as.query(api.collectionCatalog.setSummary, { setId: fx.setId });
    expect(summary).not.toBeNull();
    expect(
      summary!.variants.map((r) => [r.name, r.level, r.kind, r.cardCount, r.baseCardCount]),
    ).toEqual([
      ["Base", "variantType", "base", 3, 2],
      ["Inserts", "variantType", "insert", 0, 0],
      ["Future Stars", "insert", "insert", 1, 1],
      ["Parallels", "variantType", "parallel", 0, 0],
      ["Gold Refractor", "insert", "parallel", 1, 1],
    ]);
    expect(summary!.totalCards).toBe(5);
    expect(summary!.totalBaseCards).toBe(4);
    const future = summary!.variants.find((r) => r.name === "Future Stars")!;
    expect(future.variantType).toEqual({ _id: fx.insertsTypeId, name: "Inserts" });
    expect(future.insert).toEqual({ _id: fx.futureStarsId, name: "Future Stars" });
    expect(future.parentId).toBe(fx.insertsTypeId);
  });
});

describe("cards", () => {
  test("variantCards returns the checklist in sortOrder, hydrated", async () => {
    const { as, fx } = await setup();
    const result = await as.query(api.collectionCatalog.variantCards, { variantId: fx.baseId });
    expect(result!.variant).toMatchObject({
      _id: fx.baseId,
      kind: "base",
      cardCount: 3,
      baseCardCount: 2,
    });
    expect(result!.set?._id).toBe(fx.setId);
    expect(result!.cards.map((c) => [c.cardNumber, c.cardVariation ?? null])).toEqual([
      ["1", null],
      ["2", null],
      ["1", "Sliding"],
    ]);
    const [first, , sliding] = result!.cards;
    expect(first.players).toEqual([
      { _id: fx.goodenId, name: "Dwight Gooden", nameOnCard: "Doc Gooden" },
    ]);
    expect(first.teams).toEqual([
      {
        _id: fx.metsId,
        name: "Mets",
        location: "New York",
        primaryColor: "#002D72",
        secondaryColor: "#FF5910",
      },
    ]);
    expect(first.features).toEqual(["RC", "AU", "SP"]);
    expect(sliding.variationOfCardId).toBe(fx.gooden1);
    // The printed name equals the player's name: no nameOnCard echoed.
    expect(sliding.players[0]).toEqual({ _id: fx.goodenId, name: "Dwight Gooden" });
  });

  test("card carries its set and variant; cards keeps a null slot for a gone card", async () => {
    const { t, as, fx } = await setup();
    const gold = await as.query(api.collectionCatalog.card, { cardId: fx.gold1 });
    expect(gold!.printRun).toBe(50);
    expect(gold!.set?.name).toBe("Topps Chrome");
    expect(gold!.variant).toMatchObject({
      _id: fx.goldId,
      name: "Gold Refractor",
      kind: "parallel",
      variantType: { _id: fx.parallelsTypeId, name: "Parallels" },
      insert: { _id: fx.goldId, name: "Gold Refractor" },
      parallel: null,
    });

    await t.run(async (ctx) => ctx.db.delete(fx.strawberry2));
    const many = await as.query(api.collectionCatalog.cards, {
      cardIds: [fx.gooden1, fx.strawberry2, "garbage"],
    });
    expect(many.map((c) => c?._id ?? null)).toEqual([fx.gooden1, null, null]);
  });

  test("cards refuses more than its cap", async () => {
    const { as, fx } = await setup();
    await expect(
      as.query(api.collectionCatalog.cards, { cardIds: Array(201).fill(fx.gooden1) }),
    ).rejects.toThrow(/At most 200/);
  });
});

describe("suggest", () => {
  test("an alias offers the player it belongs to, naming the alias", async () => {
    const { as, fx } = await setup();
    const { players } = await as.query(api.collectionCatalog.suggest, { q: "Doc Gooden" });
    expect(players[0]).toEqual({
      _id: fx.goodenId,
      name: "Dwight Gooden",
      sport: { _id: fx.sportId, name: "Baseball" },
      matchedAlias: "Doc Gooden",
    });
  });

  test("a name finds the player without an alias tag", async () => {
    const { as, fx } = await setup();
    const { players } = await as.query(api.collectionCatalog.suggest, { q: "Strawberry" });
    expect(players).toEqual([
      { _id: fx.strawberryId, name: "Darryl Strawberry", sport: { _id: fx.sportId, name: "Baseball" } },
    ]);
  });

  test("teams by name or alias, with their franchise", async () => {
    const { as, fx } = await setup();
    const byName = await as.query(api.collectionCatalog.suggest, { q: "Expos" });
    expect(byName.teams[0]).toMatchObject({
      _id: fx.exposId,
      fullName: "Montreal Expos",
      name: "Expos",
      franchise: { _id: fx.franchiseId, name: "Expos / Nationals" },
    });
    const byAlias = await as.query(api.collectionCatalog.suggest, { q: "Amazins" });
    expect(byAlias.teams.map((s) => s._id)).toEqual([fx.metsId]);
    expect(byAlias.teams[0].franchise).toBeNull();
  });

  test("sets by name, narrowed by a typed year", async () => {
    const { as, fx } = await setup();
    const both = await as.query(api.collectionCatalog.suggest, { q: "Topps" });
    expect(both.sets.map((s) => s._id).sort()).toEqual([fx.setId, fx.set86Id].sort());
    const only2024 = await as.query(api.collectionCatalog.suggest, { q: "2024 Topps Chrome" });
    expect(only2024.sets.map((s) => s._id)).toEqual([fx.setId]);
    const wrongYear = await as.query(api.collectionCatalog.suggest, { q: "1986 Topps Chrome" });
    expect(wrongYear.sets).toEqual([]);
  });

  test("one character suggests nothing", async () => {
    const { as } = await setup();
    expect(await as.query(api.collectionCatalog.suggest, { q: "G" })).toEqual({
      players: [],
      teams: [],
      sets: [],
    });
  });
});

describe("search: unquoted words are terms, quoted text is a phrase", () => {
  test("every term must appear, in any order", async () => {
    const { as, fx } = await setup();
    const hits = await as.query(api.collectionCatalog.search, { q: "gooden mets chrome" });
    expect(hits.cards.map((c) => c._id).sort()).toEqual([fx.gooden1, fx.gold1].sort());
    // A term missing from every title: nothing, even though other words hit.
    const none = await as.query(api.collectionCatalog.search, { q: "gooden yankees" });
    expect(none.cards).toEqual([]);
  });

  test("a quoted phrase must appear verbatim", async () => {
    const { as, fx } = await setup();
    const phrase = await as.query(api.collectionCatalog.search, { q: '"Dwight Gooden Sliding"' });
    expect(phrase.cards.map((c) => c._id)).toEqual([fx.gooden1Sliding]);
    // The same words out of order as a phrase: no match.
    const reordered = await as.query(api.collectionCatalog.search, { q: '"Gooden Dwight"' });
    expect(reordered.cards).toEqual([]);
    // The same words unquoted: every Dwight Gooden title.
    const terms = await as.query(api.collectionCatalog.search, { q: "Gooden Dwight" });
    expect(terms.cards.map((c) => c._id).sort()).toEqual(
      [fx.gooden1Sliding, fx.futureStar, fx.gold1].sort(),
    );
  });

  test("terms and a phrase together; results carry their path", async () => {
    const { as, fx } = await setup();
    const hits = await as.query(api.collectionCatalog.search, { q: 'nationals "future stars"' });
    expect(hits.cards.map((c) => c._id)).toEqual([fx.futureStar]);
    expect(hits.cards[0].set?.name).toBe("Topps Chrome");
    expect(hits.cards[0].variant?.name).toBe("Future Stars");
  });

  test("a sport filter, and a bad sport id finds nothing", async () => {
    const { as, fx } = await setup();
    const inSport = await as.query(api.collectionCatalog.search, { q: "strawberry", sportId: fx.sportId });
    expect(inSport.cards.map((c) => c._id)).toEqual([fx.strawberry2]);
    const bad = await as.query(api.collectionCatalog.search, { q: "strawberry", sportId: "nope" });
    expect(bad.cards).toEqual([]);
  });
});

describe("a player's and a team's cards", () => {
  test("cardsByPlayer pages through every linked card", async () => {
    const { as, fx } = await setup();
    const first = await as.query(api.collectionCatalog.cardsByPlayer, { playerId: fx.goodenId, limit: 2 });
    expect(first.cards).toHaveLength(2);
    expect(first.continueCursor).not.toBeNull();
    const second = await as.query(api.collectionCatalog.cardsByPlayer, {
      playerId: fx.goodenId,
      limit: 2,
      cursor: first.continueCursor,
    });
    const third = second.continueCursor
      ? await as.query(api.collectionCatalog.cardsByPlayer, {
          playerId: fx.goodenId,
          limit: 2,
          cursor: second.continueCursor,
        })
      : { cards: [], continueCursor: null };
    const all = [...first.cards, ...second.cards, ...third.cards].map((c) => c._id);
    expect(all.sort()).toEqual([fx.gooden1, fx.gooden1Sliding, fx.futureStar, fx.gold1].sort());
    expect(third.continueCursor).toBeNull();
  });

  test("cardsByTeam is the team on the card; the franchise is an option", async () => {
    const { as, fx } = await setup();
    const expos = await as.query(api.collectionCatalog.cardsByTeam, { teamId: fx.exposId });
    expect(expos.cards.map((c) => c._id)).toEqual([fx.gooden1Sliding]);
    expect(expos.franchise).toEqual({ _id: fx.franchiseId, name: "Expos / Nationals" });

    const franchise = await as.query(api.collectionCatalog.cardsByTeam, {
      teamId: fx.exposId,
      includeFranchise: true,
    });
    expect(franchise.cards.map((c) => c._id).sort()).toEqual([fx.gooden1Sliding, fx.futureStar].sort());

    // Paged one at a time, the franchise read still reaches both teams.
    const p1 = await as.query(api.collectionCatalog.cardsByTeam, {
      teamId: fx.exposId,
      includeFranchise: true,
      limit: 1,
    });
    const p2 = await as.query(api.collectionCatalog.cardsByTeam, {
      teamId: fx.exposId,
      includeFranchise: true,
      limit: 1,
      cursor: p1.continueCursor,
    });
    expect([...p1.cards, ...p2.cards].map((c) => c._id).sort()).toEqual(
      [fx.gooden1Sliding, fx.futureStar].sort(),
    );
    expect(p2.continueCursor).toBeNull();

    const mets = await as.query(api.collectionCatalog.cardsByTeam, { teamId: fx.metsId });
    expect(mets.franchise).toBeNull();
    expect(mets.cards).toHaveLength(3);
  });

  test("a team cursor outside the team list, or with a bad time, starts from the first page", async () => {
    const { as, fx } = await setup();
    const args = { teamId: fx.exposId, includeFranchise: true, limit: 1 };
    const fresh = await as.query(api.collectionCatalog.cardsByTeam, args);
    expect(fresh.cards).toHaveLength(1);
    const bad = [
      { i: -1, t: 0 }, // negative: would read teamIds[-1]
      { i: -1, t: Number.MAX_SAFE_INTEGER },
      { i: 2, t: 0 }, // the franchise has two teams: 2 is one past the end
      { i: 99, t: 0 },
      { i: 0, t: -5 },
    ].map((c) => JSON.stringify(c));
    bad.push('{"i":0,"t":1e999}'); // JSON.parse makes this Infinity
    for (const cursor of bad) {
      const page = await as.query(api.collectionCatalog.cardsByTeam, { ...args, cursor });
      expect(page, cursor).toEqual(fresh);
    }
    // Without the franchise the list is one team, so i = 1 is already out.
    const single = await as.query(api.collectionCatalog.cardsByTeam, { teamId: fx.exposId });
    expect(
      await as.query(api.collectionCatalog.cardsByTeam, {
        teamId: fx.exposId,
        cursor: JSON.stringify({ i: 1, t: 0 }),
      }),
    ).toEqual(single);
  });

  test("a bad id is an empty list", async () => {
    const { as } = await setup();
    expect(await as.query(api.collectionCatalog.cardsByPlayer, { playerId: "x" })).toEqual({
      cards: [],
      continueCursor: null,
    });
    expect(await as.query(api.collectionCatalog.cardsByTeam, { teamId: "x" })).toEqual({
      cards: [],
      continueCursor: null,
      franchise: null,
    });
  });
});

describe("NEO-358: a row known to hold no cards is hidden; an uncounted one is shown", () => {
  type Ctx = Awaited<ReturnType<typeof setup>>;
  /** Store a row's subtree counts (null: clear them, i.e. unknown). */
  const setSubtree = (t: Ctx["t"], id: Id<"selectorOptions">, all: number | null, base = all) =>
    t.run((ctx) =>
      ctx.db.patch(id, {
        subtreeCardCount: all ?? undefined,
        subtreeNonVariationCardCount: base ?? undefined,
      }),
    );

  test("NEO-364: a sport, year or brand is shown only with hasCards; no count is read there", async () => {
    const { t, as, fx } = await setup();
    const sport = (value: string, extra: Record<string, unknown>) =>
      t.run((ctx) =>
        ctx.db.insert("selectorOptions", {
          level: "sport", value, platformData: {}, children: [], lastUpdated: 1, ...extra,
        } as never),
      );
    // No flag: hidden, even with a (stale NEO-358) subtree count that says
    // cards sit below. Flagged: shown, with no count at all.
    await sport("Basketball", {});
    await sport("Football", { subtreeCardCount: 3, subtreeNonVariationCardCount: 3 });
    await sport("Hockey", { hasCards: true });
    const sports = await as.query(api.collectionCatalog.drill, {});
    expect(sports.items.map((i) => [i.name, i.hasCards])).toEqual([
      ["Baseball", true],
      ["Hockey", true],
    ]);

    // A year loses nothing but its flag: it goes.
    await t.run((ctx) => ctx.db.patch(fx.year1986Id, { hasCards: undefined, subtreeCardCount: 5 }));
    const years = await as.query(api.collectionCatalog.drill, { level: "year", parentId: fx.sportId });
    expect(years.items.map((i) => [i.name, i.hasCards])).toEqual([["2024", true]]);

    // And a brand.
    await t.run((ctx) => ctx.db.patch(fx.topps86Id, { hasCards: undefined }));
    const brands = await as.query(api.collectionCatalog.drill, { parentId: fx.year1986Id });
    expect(brands.items).toEqual([]);
    // A flag set false (never written by the ledger) hides as absent does.
    await t.run((ctx) => ctx.db.patch(fx.toppsId, { hasCards: false }));
    expect((await as.query(api.collectionCatalog.drill, { parentId: fx.yearId })).items).toEqual([]);
  });

  test("from the set down: an exact zero is left out; unknown stays, with hasCards null", async () => {
    const { t, as, fx } = await setup();
    // Topps Chrome has never been counted: shown, its hasCards unknown.
    const sets = await as.query(api.collectionCatalog.drill, { parentId: fx.toppsId });
    expect(sets.items.map((i) => [i.name, i.hasCards])).toEqual([["Topps Chrome", null]]);
    await setSubtree(t, fx.setId, 0);
    expect((await as.query(api.collectionCatalog.drill, { parentId: fx.toppsId })).items).toEqual([]);
    await setSubtree(t, fx.setId, 5, 4);
    const counted = await as.query(api.collectionCatalog.drill, { parentId: fx.toppsId });
    expect(counted.items.map((i) => [i.name, i.hasCards])).toEqual([["Topps Chrome", true]]);

    // Future Stars has no stored counts at all: shown, hasCards null.
    const inserts = await as.query(api.collectionCatalog.drill, { level: "insert", parentId: fx.insertsTypeId });
    expect(inserts.items.map((i) => [i.name, i.hasCards])).toEqual([["Future Stars", null]]);

    // Variant types: the empty Parallels type goes; the Inserts container
    // (no cards of its own) stays because a card sits beneath it.
    await setSubtree(t, fx.insertsTypeId, 1);
    await setSubtree(t, fx.parallelsTypeId, 0);
    const types = await as.query(api.collectionCatalog.drill, { parentId: fx.setId });
    expect(types.items.map((i) => [i.name, i.hasCards])).toEqual([
      ["Base", true],
      ["Inserts", true],
    ]);
  });

  test("drill: a row whose own count holds cards is never hidden, whatever its subtree count says", async () => {
    const { t, as, fx } = await setup();
    // Base stores cardCount 3; a (drifted) subtree zero must not hide it.
    await setSubtree(t, fx.baseId, 0);
    const types = await as.query(api.collectionCatalog.drill, { parentId: fx.setId });
    expect(types.items.map((i) => i.name)).toContain("Base");
  });

  test("setSummary: zero rows go, a carded container stays, and the set's own totals are read", async () => {
    const { t, as, fx } = await setup();
    // Two rows born empty and counted: a variant type and an insert.
    const empty = await t.run(async (ctx) => {
      const counted = { cardCount: 0, nonVariationCardCount: 0, subtreeCardCount: 0, subtreeNonVariationCardCount: 0 };
      const type = await ctx.db.insert("selectorOptions", {
        level: "variantType", value: "Short Prints", parentId: fx.setId,
        platformData: {}, children: [], lastUpdated: 1, ...counted,
      });
      const insert = await ctx.db.insert("selectorOptions", {
        level: "insert", value: "Rookie Debut", parentId: fx.insertsTypeId,
        platformData: {}, children: [], lastUpdated: 1, ...counted,
      });
      return { type, insert };
    });
    // The Parallels type holds no cards of its own; its child does.
    await setSubtree(t, fx.parallelsTypeId, 1);
    const summary = await as.query(api.collectionCatalog.setSummary, { setId: fx.setId });
    const names = summary!.variants.map((r) => r.name);
    expect(names).toEqual(["Base", "Inserts", "Future Stars", "Parallels", "Gold Refractor"]);
    expect(names).not.toContain("Short Prints");
    expect(names).not.toContain("Rookie Debut");
    // Uncounted set: the totals are the sum of the rows listed.
    expect([summary!.totalCards, summary!.totalBaseCards]).toEqual([5, 4]);

    // Counted set: its stored subtree counts ARE the totals.
    await setSubtree(t, fx.setId, 40, 30);
    const fromSet = await as.query(api.collectionCatalog.setSummary, { setId: fx.setId });
    expect([fromSet!.totalCards, fromSet!.totalBaseCards]).toEqual([40, 30]);

    // And the drill leaves the same two out.
    const types = await as.query(api.collectionCatalog.drill, { parentId: fx.setId });
    expect(types.items.map((i) => i.name)).not.toContain("Short Prints");
    const inserts = await as.query(api.collectionCatalog.drill, { level: "insert", parentId: fx.insertsTypeId });
    expect(inserts.items.map((i) => i.name)).toEqual(["Future Stars"]);
    void empty;
  });

  test("suggest: a set known to be empty is not offered; an uncounted one is", async () => {
    const { t, as, fx } = await setup();
    await setSubtree(t, fx.set86Id, 0);
    const sets = await as.query(api.collectionCatalog.suggest, { q: "Topps" });
    expect(sets.sets.map((s) => s._id)).toEqual([fx.setId]);
  });
});

describe("NEO-367 card notes", () => {
  test("a card's note reaches the collector; a card without one carries no key", async () => {
    const { t, as, fx } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(fx.gooden1, { notes: "Short print, about 1:120 packs" });
    });
    const card = await as.query(api.collectionCatalog.card, { cardId: fx.gooden1 });
    expect(card?.notes).toBe("Short print, about 1:120 packs");
    const other = await as.query(api.collectionCatalog.card, { cardId: fx.gold1 });
    expect(other).not.toBeNull();
    expect("notes" in other!).toBe(false);
  });
});
