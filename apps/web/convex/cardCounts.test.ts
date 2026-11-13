/**
 * NEO-358 — `selectorOptions.cardCount` / `nonVariationCardCount`, kept by the
 * per-mutation `CardCountLedger` (convex/cardCounts.ts).
 *
 * One case per writer (each of them ends with the stored counts equal to a
 * fresh recount), the ledger's own recount and drift paths, the armed
 * backfill, and the collector guard every card delete now runs
 * (`removeCardRow`): refused, skipped or blocked depending on the caller.
 * `cardCounts.pin.test.ts` pins that no writer is missed; this proves each one
 * lands the right numbers.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import {
  createCardCountLedger,
  parseResumeCursor,
  recountCards,
} from "./cardCounts";
import { insertCardRow } from "./cardRowCreate";
import { COLLECTOR_COUNT_LINES, countCollectors, removeCardRow } from "./cardRowDelete";
import { moveBuildingSets, moveCards } from "./setShapeMove";
import {
  blockedCollectedReason,
  collectedCardRefusal,
  keptCollectedNote,
} from "../lib/collection/collectors";
import {
  confirmPhraseFor,
  ENV_FLAG as WIPE_ENV_FLAG,
} from "./wipeVariantTypeSubtree";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "user_admin", role: "admin" };
const NOW = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Baseball › 2024 › Topps › Chrome, with a Base variant type, an Insert type
 * holding one insert ("Gold") and one parallel under it ("Gold Refractor").
 * Counts start ABSENT everywhere, as on a row written before NEO-358.
 */
async function seed(t: T) {
  return t.run(async (ctx) => {
    const row = (
      level: Doc<"selectorOptions">["level"],
      value: string,
      parentId?: Id<"selectorOptions">,
    ) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        ...(parentId ? { parentId } : {}),
        platformData: {},
        children: [],
        lastUpdated: NOW,
      });
    const sport = await row("sport", "Baseball");
    const year = await row("year", "2024", sport);
    const brand = await row("manufacturer", "Topps", year);
    const set = await row("setName", "Chrome", brand);
    const otherSet = await row("setName", "Finest", brand);
    const base = await row("variantType", "Base", set);
    const otherBase = await row("variantType", "Base", otherSet);
    const insertType = await row("variantType", "Insert", set);
    const insert = await row("insert", "Gold", insertType);
    const parallel = await row("parallel", "Gold Refractor", insert);
    const home = await ctx.db.insert("collectionContainers", {
      ownerId: "collector_1",
      kind: "binder",
      system: "main",
      name: "Main",
      lastUpdated: NOW,
    });
    return { sport, year, brand, set, otherSet, base, otherBase, insertType, insert, parallel, home };
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

async function addCard(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  cardNumber: string,
  extra: Partial<Doc<"cardChecklist">> = {},
): Promise<Id<"cardChecklist">> {
  return t.run((ctx) =>
    insertTestCard(ctx, {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      listingTitle: `Card ${cardNumber}`,
      platformData: {},
      sortOrder: Number.parseInt(cardNumber, 10) || 0,
      lastUpdated: NOW,
      ...extra,
    }),
  );
}

async function addCopy(t: T, s: Seeded, cardId: Id<"cardChecklist">, ownerId = "collector_1") {
  return t.run(async (ctx) => {
    const card = (await ctx.db.get(cardId))!;
    return ctx.db.insert("collectionCopies", {
      ownerId,
      cardId,
      variantId: card.selectorOptionId,
      setId: s.set,
      homeId: s.home,
      quantity: 1,
      lastUpdated: NOW,
    });
  });
}

/** The stored counts on a row. */
const stored = (t: T, id: Id<"selectorOptions">) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.get(id))!;
    return { cardCount: row.cardCount, nonVariationCardCount: row.nonVariationCardCount };
  });

/** A fresh recount of a row, to hold the stored counts against. */
const truth = (t: T, id: Id<"selectorOptions">) =>
  t.run(async (ctx) => (await recountCards(ctx, id))!);

/** Store the true counts, so a writer's DELTA (not a recount) is under test. */
const primeCounts = (t: T, ...ids: Array<Id<"selectorOptions">>) =>
  t.run(async (ctx) => {
    for (const id of ids) {
      await ctx.db.patch(id, (await recountCards(ctx, id))!);
    }
  });

describe("the ledger", () => {
  test("an absent count is recounted in place, both counts, including this transaction's writes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await addCard(t, s.base, "1");
    await addCard(t, s.base, "1a", { variationOfCardId: parent });
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      const id = await insertTestCard(ctx, {
        selectorOptionId: s.base,
        cardNumber: "2",
        cardName: "Two",
        platformData: {},
        sortOrder: 2,
        lastUpdated: NOW,
      });
      ledger.addCard((await ctx.db.get(id))!);
      await ledger.flush(ctx);
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 3, nonVariationCardCount: 2 });
  });

  test("a present count moves by the delta alone, with no read of the checklist", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // Deliberately WRONG stored counts: a delta write leaves the error alone,
    // which proves no recount happened.
    await t.run((ctx) => ctx.db.patch(s.base, { cardCount: 40, nonVariationCardCount: 30 }));
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      ledger.add(s.base, 2, 1);
      ledger.add(s.base, -1, -1);
      expect(ledger.deltaFor(s.base)).toEqual({ all: 1, nonVariation: 0 });
      await ledger.flush(ctx);
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 41, nonVariationCardCount: 30 });
  });

  test("a delta that would go negative recounts and logs card_count_drift", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    await addCard(t, s.base, "2");
    await t.run((ctx) => ctx.db.patch(s.base, { cardCount: 0, nonVariationCardCount: 0 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      ledger.add(s.base, -1, -1);
      await ledger.flush(ctx);
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 2, nonVariationCardCount: 2 });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"msg":"card_count_drift"'))).toBe(true);
  });

  test("a zero delta writes nothing, a second flush is a no-op, and a deleted row is skipped", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      ledger.add(s.base, 1, 1);
      ledger.add(s.base, -1, -1);
      ledger.add(s.parallel, 1, 1);
      await ctx.db.delete(s.parallel);
      await ledger.flush(ctx);
      await ledger.flush(ctx);
    });
    expect(await stored(t, s.base)).toEqual({
      cardCount: undefined,
      nonVariationCardCount: undefined,
    });
  });

  test("variationChanged counts only a transition", async () => {
    const ledger = createCardCountLedger();
    const id = "row" as unknown as Id<"selectorOptions">;
    ledger.variationChanged(id, true, true);
    ledger.variationChanged(id, false, false);
    expect(ledger.deltaFor(id)).toEqual({ all: 0, nonVariation: 0 });
    ledger.variationChanged(id, false, true);
    expect(ledger.deltaFor(id)).toEqual({ all: 0, nonVariation: -1 });
    ledger.variationChanged(id, true, false);
    ledger.variationChanged(id, true, false);
    expect(ledger.deltaFor(id)).toEqual({ all: 0, nonVariation: 1 });
  });
});

describe("every writer lands the true counts", () => {
  test("insertCardRow (commit chunk + parallel build): +1, a born variation counts in cardCount only", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await addCard(t, s.parallel, "1");
    await primeCounts(t, s.parallel);
    const set = { sportValue: "Baseball", setNameValue: "Chrome" };
    const card = (cardNumber: string, extra = {}) => ({
      selectorOptionId: s.parallel,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: {},
      pendingPlayerNames: [],
      pendingTeamNames: [],
      sortOrder: 0,
      playerNames: [],
      ...extra,
    });
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      const sport = async () => s.sport;
      await insertCardRow(ctx, card("2"), set, { sport }, ledger);
      await insertCardRow(
        ctx,
        card("1b", { carried: { variationOfCardId: parent } }),
        set,
        { sport },
        ledger,
      );
      await ledger.flush(ctx);
    });
    expect(await stored(t, s.parallel)).toEqual({ cardCount: 3, nonVariationCardCount: 2 });
    expect(await stored(t, s.parallel)).toEqual(await truth(t, s.parallel));
    // NEO-358 — and the sport is stamped at insert (required since NEO-363,
    // so the fixture's own parent card carries it too).
    const sportIds = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("cardChecklist")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", s.parallel))
          .collect()
      ).map((c) => c.sportId),
    );
    expect(sportIds).toEqual([s.sport, s.sport, s.sport]);
  });

  test("commitCardChecklistChunk: one flush for the chunk's inserts", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    await primeCounts(t, s.base);
    await t.mutation(internal.selectorOptions.commitCardChecklistChunk, {
      selectorOptionId: s.base,
      sportValue: "Baseball",
      setNameValue: "Chrome",
      cards: ["2", "3", "4"].map((n, i) => ({
        cardNumber: n,
        cardName: `Card ${n}`,
        platformData: {},
        sortOrder: i + 2,
        playerNames: [],
        teamNames: [],
      })),
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 4, nonVariationCardCount: 4 });
    expect(await stored(t, s.base)).toEqual(await truth(t, s.base));
  });

  test("addCustomCard: +1, and the card carries its sport", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    await primeCounts(t, s.base);
    const id = await t.withIdentity(ADMIN).mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: s.base,
      cardNumber: "9001",
      cardName: "Hand Added",
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 2, nonVariationCardCount: 2 });
    expect(await t.run(async (ctx) => (await ctx.db.get(id))!.sportId)).toBe(s.sport);
  });

  test("deleteCard: −1, and its promoted variations join the base count", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await addCard(t, s.base, "1");
    await addCard(t, s.base, "1a", { variationOfCardId: parent });
    await addCard(t, s.base, "1b", { variationOfCardId: parent });
    await primeCounts(t, s.base);
    expect(await stored(t, s.base)).toEqual({ cardCount: 3, nonVariationCardCount: 1 });
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteCard, { id: parent });
    expect(await stored(t, s.base)).toEqual({ cardCount: 2, nonVariationCardCount: 2 });
    expect(await stored(t, s.base)).toEqual(await truth(t, s.base));
  });

  test("setCardVariationParent: setting and clearing move the base count only", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await addCard(t, s.base, "1");
    const child = await addCard(t, s.base, "1a");
    await primeCounts(t, s.base);
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.selectorOptions.setCardVariationParent, {
      cardId: child,
      parentCardId: parent,
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 2, nonVariationCardCount: 1 });
    // Re-setting the same parent is no transition.
    await admin.mutation(api.selectorOptions.setCardVariationParent, {
      cardId: child,
      parentCardId: parent,
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 2, nonVariationCardCount: 1 });
    await admin.mutation(api.selectorOptions.setCardVariationParent, { cardId: child });
    expect(await stored(t, s.base)).toEqual({ cardCount: 2, nonVariationCardCount: 2 });
  });

  test("commitCardChecklistFinalize: operator deletes −n; variation links and clears move the base count", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const keep = await addCard(t, s.base, "5");
    const child = await addCard(t, s.base, "5a");
    const wasChild = await addCard(t, s.base, "6a", { variationOfCardId: keep });
    const doomed = await addCard(t, s.base, "7");
    await primeCounts(t, s.base);
    const finalize = (overrides: Record<string, unknown>) =>
      t.mutation(internal.selectorOptions.commitCardChecklistFinalize, {
        selectorOptionId: s.base,
        committedIds: [keep, child, wasChild],
        committedNumbers: ["5", "5a", "6a"],
        operatorDeleteIds: [],
        variationLinks: [],
        variationClearIds: [],
        customSortOrders: [],
        resolvedPlayerNames: [],
        resolvedTeamNames: [],
        skippedPlayerNames: [],
        skippedTeamNames: [],
        reviewRowIds: [],
        bscTeamEnrichmentIds: [],
        cardCount: 3,
        ...overrides,
      });
    // Page 1: the delete.
    await finalize({ operatorDeleteIds: [doomed] });
    expect(await stored(t, s.base)).toEqual({ cardCount: 3, nonVariationCardCount: 2 });
    // Page 2: the row walk links one variation and clears another.
    await finalize({
      variationLinks: [{ childId: child, parentId: keep }],
      variationClearIds: [wasChild],
      resume: { phase: "rows", offset: 0, rowCursor: null },
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 3, nonVariationCardCount: 2 });
    expect(await stored(t, s.base)).toEqual(await truth(t, s.base));
    const rows = await t.run(async (ctx) => [await ctx.db.get(child), await ctx.db.get(wasChild)]);
    expect(rows[0]!.variationOfCardId).toBe(keep);
    expect(rows[1]!.variationOfCardId).toBeUndefined();
  });

  test("deleteParallelCardsPage: the parallel's counts go to zero", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.parallel, "1");
    await addCard(t, s.parallel, "2");
    await primeCounts(t, s.parallel);
    const result = await t.mutation(internal.parallelChecklistBuild.deleteParallelCardsPage, {
      parallelId: s.parallel,
    });
    expect(result.deleted).toBe(2);
    expect(await stored(t, s.parallel)).toEqual({ cardCount: 0, nonVariationCardCount: 0 });
  });

  test("wipeCardsPage: every wiped card, children included, leaves the counts", async () => {
    vi.stubEnv(WIPE_ENV_FLAG, "true");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await addCard(t, s.insert, "1");
    await addCard(t, s.insert, "1a", { variationOfCardId: parent });
    await addCard(t, s.insert, "2");
    await primeCounts(t, s.insert);
    const confirm = confirmPhraseFor("Insert", ["Baseball", "2024", "Topps", "Chrome"], s.insertType);
    await t.mutation(internal.wipeVariantTypeSubtree.wipeCardsPage, {
      variantTypeId: s.insertType,
      confirm,
      nodeId: s.insert,
    });
    expect(await stored(t, s.insert)).toEqual({ cardCount: 0, nonVariationCardCount: 0 });
  });

  test("moveCards: −n on each source, +n on the destination, copies follow, one flush", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = await addCard(t, s.base, "1");
    const b = await addCard(t, s.base, "1a", { variationOfCardId: a });
    const c = await addCard(t, s.base, "2");
    await addCard(t, s.otherBase, "9");
    await primeCounts(t, s.base, s.otherBase);
    const copy = await addCopy(t, s, a);
    await t.run(async (ctx) => {
      const cards = await Promise.all([a, b].map((id) => ctx.db.get(id)));
      await moveCards(
        ctx,
        s.otherBase,
        cards.map((card) => ({ card: card!, slotMap: {} })),
        NOW,
      );
    });
    expect(await stored(t, s.base)).toEqual({ cardCount: 1, nonVariationCardCount: 1 });
    expect(await stored(t, s.otherBase)).toEqual({ cardCount: 3, nonVariationCardCount: 2 });
    expect(await stored(t, s.base)).toEqual(await truth(t, s.base));
    expect(await stored(t, s.otherBase)).toEqual(await truth(t, s.otherBase));
    const moved = await t.run(async (ctx) => (await ctx.db.get(copy))!);
    expect(moved.variantId).toBe(s.otherBase);
    expect(moved.setId).toBe(s.otherSet);
    void c;
  });
});

describe("the collector guard on every card delete", () => {
  test("deleteCard refuses a card a collector owns, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await addCard(t, s.base, "1");
    await addCopy(t, s, card);
    await primeCounts(t, s.base);
    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteCard, { id: card }),
    ).rejects.toThrow("Hold up! A collector has this card, so it stays in the catalog.");
    expect(await t.run((ctx) => ctx.db.get(card))).not.toBeNull();
    expect(await stored(t, s.base)).toEqual({ cardCount: 1, nonVariationCardCount: 1 });
  });

  test("removeCardRow itself refuses, so a caller that skips its page check still loses nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await addCard(t, s.base, "1");
    await addCopy(t, s, card);
    await expect(
      t.run(async (ctx) => {
        await removeCardRow(ctx, (await ctx.db.get(card))!, createCardCountLedger());
      }),
    ).rejects.toThrow(collectedCardRefusal({ collectors: 1, atLeast: false }));
    expect(await t.run((ctx) => ctx.db.get(card))).not.toBeNull();
  });

  test("commitCardChecklistFinalize skips a collected card, counts it, and deletes the rest", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const owned = await addCard(t, s.base, "1");
    const free = await addCard(t, s.base, "2");
    await addCopy(t, s, owned);
    const page = await t.mutation(internal.selectorOptions.commitCardChecklistFinalize, {
      selectorOptionId: s.base,
      committedIds: [],
      committedNumbers: [],
      operatorDeleteIds: [owned, free],
      variationLinks: [],
      variationClearIds: [],
      customSortOrders: [],
      resolvedPlayerNames: [],
      resolvedTeamNames: [],
      skippedPlayerNames: [],
      skippedTeamNames: [],
      reviewRowIds: [],
      bscTeamEnrichmentIds: [],
      cardCount: 0,
    });
    expect(page.operatorDeleted).toBe(1);
    expect(page.deleteSkipped).toBe(1);
    expect(page.collectedSkipped).toBe(1);
    expect(page.collectedCollectors).toBe(1);
    expect(page).not.toHaveProperty("collectedCollectorsAtLeast");
    expect(await t.run((ctx) => ctx.db.get(owned))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(free))).toBeNull();
  });

  test("a page with no collected card reports no collectedSkipped at all", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const free = await addCard(t, s.base, "2");
    const page = await t.mutation(internal.selectorOptions.commitCardChecklistFinalize, {
      selectorOptionId: s.base,
      committedIds: [],
      committedNumbers: [],
      operatorDeleteIds: [free],
      variationLinks: [],
      variationClearIds: [],
      customSortOrders: [],
      resolvedPlayerNames: [],
      resolvedTeamNames: [],
      skippedPlayerNames: [],
      skippedTeamNames: [],
      reviewRowIds: [],
      bscTeamEnrichmentIds: [],
      cardCount: 0,
    });
    expect(page).not.toHaveProperty("collectedSkipped");
    expect(page).not.toHaveProperty("collectedCollectors");
  });

  test("the parallel rebuild is BLOCKED by a collected card, and the page deletes nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.parallel, "1");
    const owned = await addCard(t, s.parallel, "2");
    await addCopy(t, s, owned);
    const result = await t.mutation(internal.parallelChecklistBuild.deleteParallelCardsPage, {
      parallelId: s.parallel,
    });
    expect(result).toMatchObject({
      deleted: 0,
      done: true,
      blockedReason: blockedCollectedReason({ collectors: 1, atLeast: false }),
    });
    const left = await t.run((ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", s.parallel))
        .collect(),
    );
    expect(left).toHaveLength(2);
  });

  test("the parallel's block check names the collected card's block too", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const owned = await addCard(t, s.parallel, "2");
    await addCopy(t, s, owned);
    const check = await t.query(internal.parallelChecklistBuild.checkParallelBuildBlocksPage, {
      parallelId: s.parallel,
      cursor: null,
    });
    // One collected card read; the page's others were not checked for theirs.
    expect(check.blockedReason).toBe(blockedCollectedReason({ collectors: 1, atLeast: true }));
  });

  test("the subtree wipe refuses a collected card, and its dry run counts it", async () => {
    vi.stubEnv(WIPE_ENV_FLAG, "true");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const owned = await addCard(t, s.insert, "1");
    await addCard(t, s.insert, "2");
    await addCopy(t, s, owned);
    const confirm = confirmPhraseFor("Insert", ["Baseball", "2024", "Topps", "Chrome"], s.insertType);
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.wipeCardsPage, {
        variantTypeId: s.insertType,
        confirm,
        nodeId: s.insert,
      }),
    ).rejects.toThrow(/collector/);
    expect(await t.run((ctx) => ctx.db.get(owned))).not.toBeNull();

    const dry = await t.action(internal.wipeVariantTypeSubtree.run, {
      variantTypeId: s.insertType,
    });
    if (dry.mode !== "dryRun") throw new Error("expected a dry run");
    const row = dry.beyondChecklist.find((r) => r.id === s.insert);
    expect(row?.holds.cardsCollected).toBe(1);
  });

  test("a variation child off the wipe's page is checked as it is reached", async () => {
    vi.stubEnv(WIPE_ENV_FLAG, "true");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await addCard(t, s.insert, "1");
    // The child lives on the parallel, inside the subtree but off this page.
    const child = await addCard(t, s.parallel, "1a", { variationOfCardId: parent });
    await addCopy(t, s, child);
    const confirm = confirmPhraseFor("Insert", ["Baseball", "2024", "Topps", "Chrome"], s.insertType);
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.wipeCardsPage, {
        variantTypeId: s.insertType,
        confirm,
        nodeId: s.insert,
      }),
    ).rejects.toThrow(/collector/);
    expect(await t.run((ctx) => ctx.db.get(parent))).not.toBeNull();
  });
});

describe("set-level collector bookkeeping", () => {
  test("an empty set deleted from the trash icon sweeps its building entries", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(s.otherBase);
      await ctx.db.insert("collectionBuildingSets", {
        ownerId: "collector_1",
        setId: s.otherSet,
        lastUpdated: NOW,
      });
    });
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteSelectorOption, {
      id: s.otherSet,
    });
    const left = await t.run((ctx) => ctx.db.query("collectionBuildingSets").collect());
    expect(left).toEqual([]);
  });

  test("moveBuildingSets re-points entries, de-duplicated per owner", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (const ownerId of ["a", "b"]) {
        await ctx.db.insert("collectionBuildingSets", { ownerId, setId: s.otherSet, lastUpdated: NOW });
      }
      // "b" already builds the target.
      await ctx.db.insert("collectionBuildingSets", { ownerId: "b", setId: s.set, lastUpdated: NOW });
      await moveBuildingSets(ctx, s.otherSet, s.set, NOW);
    });
    const rows = await t.run((ctx) => ctx.db.query("collectionBuildingSets").collect());
    expect(rows.map((r) => `${r.ownerId}:${r.setId === s.set ? "target" : "source"}`).sort()).toEqual([
      "a:target",
      "b:target",
    ]);
  });
});

describe("backfillVariantCardCounts", () => {
  test("a dry run writes nothing and reports what it would fill", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    const result = await t.action(internal.cardCounts.backfillVariantCardCounts, {});
    expect(result.armed).toBe(false);
    expect(result.complete).toBe(true);
    // Base, Base (Finest), Insert type, the insert and the parallel.
    expect(result.filled).toBe(5);
    expect(await stored(t, s.base)).toEqual({
      cardCount: undefined,
      nonVariationCardCount: undefined,
    });
  });

  test("an armed run on an unarmed deployment is refused, not thrown", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const result = await t.action(internal.cardCounts.backfillVariantCardCounts, {
      confirm: "BACKFILL",
    });
    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/not armed/);
  });

  test("armed: fills both counts; a disagreeing count is fixed only with repair", async () => {
    vi.stubEnv("ALLOW_CARD_COUNT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const parent = await addCard(t, s.base, "1");
    await addCard(t, s.base, "1a", { variationOfCardId: parent });
    await t.run((ctx) => ctx.db.patch(s.parallel, { cardCount: 7, nonVariationCardCount: 7 }));

    const first = await t.action(internal.cardCounts.backfillVariantCardCounts, {
      confirm: "BACKFILL",
    });
    expect(first).toMatchObject({ armed: true, complete: true, filled: 4, disagreed: 1, repaired: 0 });
    expect(await stored(t, s.base)).toEqual({ cardCount: 2, nonVariationCardCount: 1 });
    expect(await stored(t, s.parallel)).toEqual({ cardCount: 7, nonVariationCardCount: 7 });

    const repair = await t.action(internal.cardCounts.backfillVariantCardCounts, {
      confirm: "BACKFILL",
      repair: true,
    });
    expect(repair).toMatchObject({ filled: 0, disagreed: 1, repaired: 1 });
    expect(await stored(t, s.parallel)).toEqual({ cardCount: 0, nonVariationCardCount: 0 });

    const again = await t.action(internal.cardCounts.backfillVariantCardCounts, {
      confirm: "BACKFILL",
    });
    expect(again).toMatchObject({ filled: 0, disagreed: 0, repaired: 0 });
  });

  test("pages across levels and resumes from the cursor it returns", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const result = await t.action(internal.cardCounts.backfillVariantCardCounts, { numItems: 1 });
    expect(result.complete).toBe(true);
    expect(result.scanned).toBe(5);
    expect(parseResumeCursor("insert:3:abc:def")).toEqual({
      levelIndex: 1,
      skip: 3,
      cursor: "abc:def",
    });
    expect(() => parseResumeCursor("setName:0:")).toThrow(/not one this backfill returned/);
  });
});

describe("a refusal says how many collectors are in the way", () => {
  test("deleteCard names the collectors, each once however many copies they hold", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await addCard(t, s.base, "1");
    for (const owner of ["collector_a", "collector_b", "collector_c", "collector_a"]) {
      await addCopy(t, s, card, owner);
    }
    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteCard, { id: card }),
    ).rejects.toThrow("Hold up! 3 collectors have this card, so it stays in the catalog.");
  });

  test("past the bounded read the count is a floor, never a guess", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await addCard(t, s.base, "1");
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(card))!;
      for (let i = 0; i <= COLLECTOR_COUNT_LINES; i += 1) {
        await ctx.db.insert("collectionCopies", {
          ownerId: `collector_${i}`,
          cardId: card,
          variantId: c.selectorOptionId,
          setId: s.set,
          homeId: s.home,
          quantity: 1,
          lastUpdated: NOW,
        });
      }
    });
    expect(await t.run((ctx) => countCollectors(ctx, [card]))).toEqual({
      collectors: COLLECTOR_COUNT_LINES,
      atLeast: true,
    });
    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.deleteCard, { id: card }),
    ).rejects.toThrow(`Hold up! ${COLLECTOR_COUNT_LINES}+ collectors have this card`);
  });

  test("the parallel rebuild's block counts the collectors across the collected cards it read", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const one = await addCard(t, s.parallel, "1");
    const two = await addCard(t, s.parallel, "2");
    await addCopy(t, s, one, "collector_a");
    await addCopy(t, s, two, "collector_b");
    await addCopy(t, s, two, "collector_a");
    const result = await t.mutation(internal.parallelChecklistBuild.deleteParallelCardsPage, {
      parallelId: s.parallel,
    });
    expect(result.blockedReason).toBe(
      "2 collectors own copies of its cards, and a rebuild would pull those cards out from under them",
    );
  });

  test("the subtree wipe's refusal names the collectors", async () => {
    vi.stubEnv(WIPE_ENV_FLAG, "true");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const owned = await addCard(t, s.insert, "1");
    await addCopy(t, s, owned, "collector_a");
    await addCopy(t, s, owned, "collector_b");
    const confirm = confirmPhraseFor("Insert", ["Baseball", "2024", "Topps", "Chrome"], s.insertType);
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.wipeCardsPage, {
        variantTypeId: s.insertType,
        confirm,
        nodeId: s.insert,
      }),
    ).rejects.toThrow(/is in 2 collectors' collections/);
  });

  test("the checklist commit reports the collectors behind the cards it kept", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const one = await addCard(t, s.base, "1");
    const two = await addCard(t, s.base, "2");
    await addCopy(t, s, one, "collector_a");
    await addCopy(t, s, two, "collector_b");
    await addCopy(t, s, two, "collector_c");
    const page = await t.mutation(internal.selectorOptions.commitCardChecklistFinalize, {
      selectorOptionId: s.base,
      committedIds: [],
      committedNumbers: [],
      operatorDeleteIds: [one, two],
      variationLinks: [],
      variationClearIds: [],
      customSortOrders: [],
      resolvedPlayerNames: [],
      resolvedTeamNames: [],
      skippedPlayerNames: [],
      skippedTeamNames: [],
      reviewRowIds: [],
      bscTeamEnrichmentIds: [],
      cardCount: 0,
    });
    expect(page).toMatchObject({ collectedSkipped: 2, collectedCollectors: 3 });
    expect(keptCollectedNote(2, { collectors: page.collectedCollectors!, atLeast: false })).toBe(
      "Kept 2 cards: 3 collectors have them, so they stay in the catalog.",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NEO-532 — `lastCardAt`, stamped by the same flush that keeps the counts
// ───────────────────────────────────────────────────────────────────────────

describe("lastCardAt (NEO-532)", () => {
  const STAMP = 1_800_000_000_000;
  afterEach(() => vi.useRealTimers());

  /** Date-only fake clock, so `Date.now()` at flush is exactly `at`. */
  function clock(at: number) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
  }

  const stampOf = (t: T, id: Id<"selectorOptions">) =>
    t.run(async (ctx) => (await ctx.db.get(id))!.lastCardAt ?? null);

  /** A flush that lands `cardNumber` on `rowId`, as insertCardRow's ledger does. */
  async function land(t: T, rowId: Id<"selectorOptions">, cardNumber: string) {
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      const id = await insertTestCard(ctx, {
        selectorOptionId: rowId,
        cardNumber,
        cardName: `Card ${cardNumber}`,
        platformData: {},
        sortOrder: Number.parseInt(cardNumber, 10) || 0,
        lastUpdated: NOW,
      });
      ledger.addCard((await ctx.db.get(id))!);
      await ledger.flush(ctx);
    });
  }

  test("a card inserted stamps its own row, and no ancestor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    clock(STAMP);
    await land(t, s.parallel, "1");
    expect(await stampOf(t, s.parallel)).toBe(STAMP);
    for (const ancestor of [s.insert, s.insertType, s.set, s.brand, s.year, s.sport]) {
      expect(await stampOf(t, ancestor)).toBeNull();
    }
  });

  test("insertCardRow through its ledger stamps the destination", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    clock(STAMP);
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      await insertCardRow(
        ctx,
        {
          selectorOptionId: s.base,
          cardNumber: "1",
          cardName: "One",
          platformData: {},
          pendingPlayerNames: [],
          pendingTeamNames: [],
          sortOrder: 0,
          playerNames: [],
        },
        { sportValue: "Baseball", setNameValue: "Chrome" },
        { sport: async () => s.sport },
        ledger,
      );
      await ledger.flush(ctx);
    });
    expect(await stampOf(t, s.base)).toBe(STAMP);
    expect(await stampOf(t, s.set)).toBeNull();
  });

  test("a second landing moves the stamp forward", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    clock(STAMP);
    await land(t, s.base, "1");
    vi.setSystemTime(STAMP + 60_000);
    await land(t, s.base, "2");
    expect(await stampOf(t, s.base)).toBe(STAMP + 60_000);
  });

  test("moveCards stamps the destination and leaves the source's stamp alone", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    clock(STAMP);
    const a = await addCard(t, s.base, "1");
    await addCard(t, s.base, "2");
    await land(t, s.otherBase, "9");
    await primeCounts(t, s.base, s.otherBase);
    await t.run((ctx) => ctx.db.patch(s.base, { lastCardAt: STAMP - 1000 }));
    vi.setSystemTime(STAMP + 5000);
    await t.run(async (ctx) => {
      await moveCards(ctx, s.otherBase, [{ card: (await ctx.db.get(a))!, slotMap: {} }], NOW);
    });
    expect(await stampOf(t, s.otherBase)).toBe(STAMP + 5000);
    expect(await stampOf(t, s.base)).toBe(STAMP - 1000);
  });

  test("a removal alone does not stamp, and leaves an existing stamp where it was", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    clock(STAMP);
    const a = await addCard(t, s.base, "1");
    await addCard(t, s.base, "2");
    await primeCounts(t, s.base);
    await t.run((ctx) => ctx.db.patch(s.base, { lastCardAt: STAMP - 1000 }));
    vi.setSystemTime(STAMP + 5000);
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      await removeCardRow(ctx, (await ctx.db.get(a))!, ledger);
      await ledger.flush(ctx);
    });
    expect(await stored(t, s.base)).toMatchObject({ cardCount: 1 });
    expect(await stampOf(t, s.base)).toBe(STAMP - 1000);
  });

  test("a removal on an unstamped row leaves it unstamped", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = await addCard(t, s.base, "1");
    await addCard(t, s.base, "2");
    await primeCounts(t, s.base);
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      await removeCardRow(ctx, (await ctx.db.get(a))!, ledger);
      await ledger.flush(ctx);
    });
    expect(await stampOf(t, s.base)).toBeNull();
  });

  test("a card added and another removed in one mutation still stamps, though the count is unchanged", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    clock(STAMP);
    const a = await addCard(t, s.base, "1");
    await primeCounts(t, s.base);
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      const fresh = await insertTestCard(ctx, {
        selectorOptionId: s.base,
        cardNumber: "2",
        cardName: "Two",
        platformData: {},
        sortOrder: 2,
        lastUpdated: NOW,
      });
      ledger.addCard((await ctx.db.get(fresh))!);
      await removeCardRow(ctx, (await ctx.db.get(a))!, ledger);
      expect(ledger.deltaFor(s.base)).toEqual({ all: 0, nonVariation: 0 });
      await ledger.flush(ctx);
    });
    expect(await stored(t, s.base)).toMatchObject({ cardCount: 1 });
    expect(await stampOf(t, s.base)).toBe(STAMP);
  });

  test("a flush that takes the row to zero cards clears the stamp", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    clock(STAMP);
    const a = await addCard(t, s.base, "1");
    await primeCounts(t, s.base);
    await t.run((ctx) => ctx.db.patch(s.base, { lastCardAt: STAMP }));
    await t.run(async (ctx) => {
      const ledger = createCardCountLedger();
      await removeCardRow(ctx, (await ctx.db.get(a))!, ledger);
      await ledger.flush(ctx);
    });
    expect(await stored(t, s.base)).toMatchObject({ cardCount: 0 });
    expect(await stampOf(t, s.base)).toBeNull();
  });
});

describe("backfillLastCardAt (NEO-532)", () => {
  test("a dry run writes nothing and reports what it would stamp", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    await addCard(t, s.parallel, "1");
    const result = await t.action(internal.cardCounts.backfillLastCardAt, {});
    expect(result).toMatchObject({ armed: false, complete: true, filled: 2, alreadyStamped: 0, empty: 3 });
    expect(await t.run(async (ctx) => (await ctx.db.get(s.base))!.lastCardAt ?? null)).toBeNull();
  });

  test("an armed run on an unarmed deployment is refused, not thrown, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    const result = await t.action(internal.cardCounts.backfillLastCardAt, { confirm: "BACKFILL" });
    expect(result.armed).toBe(false);
    expect(result.message).toMatch(/not armed/);
    expect(await t.run(async (ctx) => (await ctx.db.get(s.base))!.lastCardAt ?? null)).toBeNull();
  });

  test("armed: stamps each row from its newest card's creation time, and a rerun writes nothing", async () => {
    vi.stubEnv("ALLOW_LAST_CARD_AT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    const newest = await addCard(t, s.base, "2");
    await addCard(t, s.parallel, "1");
    const newestAt = await t.run(async (ctx) => (await ctx.db.get(newest))!._creationTime);

    const first = await t.action(internal.cardCounts.backfillLastCardAt, { confirm: "BACKFILL" });
    expect(first).toMatchObject({ armed: true, complete: true, filled: 2, alreadyStamped: 0 });
    expect(await t.run(async (ctx) => (await ctx.db.get(s.base))!.lastCardAt)).toBe(newestAt);
    // The empty rows, and every ancestor, stay unstamped.
    for (const id of [s.otherBase, s.insertType, s.insert, s.set, s.sport]) {
      expect(await t.run(async (ctx) => (await ctx.db.get(id))!.lastCardAt ?? null)).toBeNull();
    }

    const again = await t.action(internal.cardCounts.backfillLastCardAt, { confirm: "BACKFILL" });
    expect(again).toMatchObject({ filled: 0, alreadyStamped: 2 });
  });

  test("a row that already carries a stamp keeps it, even a newer one than its cards", async () => {
    vi.stubEnv("ALLOW_LAST_CARD_AT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    await t.run((ctx) => ctx.db.patch(s.base, { lastCardAt: 42 }));
    const result = await t.action(internal.cardCounts.backfillLastCardAt, { confirm: "BACKFILL" });
    expect(result).toMatchObject({ filled: 0, alreadyStamped: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.get(s.base))!.lastCardAt)).toBe(42);
  });

  test("pages across levels with numItems 1 and still stamps every row", async () => {
    vi.stubEnv("ALLOW_LAST_CARD_AT_BACKFILL", "1");
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addCard(t, s.base, "1");
    await addCard(t, s.insert, "1");
    await addCard(t, s.parallel, "1");
    const result = await t.action(internal.cardCounts.backfillLastCardAt, {
      confirm: "BACKFILL",
      numItems: 1,
    });
    expect(result).toMatchObject({ complete: true, scanned: 5, filled: 3 });
  });
});
