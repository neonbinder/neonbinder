/**
 * NEO-335 — the set's short name for titles, and the chain facts every title
 * walk reads.
 *
 * The commit half: the wizard's Card titles step sends ONE `listingShortName`
 * for the batch. It is held to its rule before any phase writes, and written
 * onto the LEAF row by the prelude before any chunk titles a card — so the
 * title the step showed (built from `titleSetFacts` plus the draft) is the
 * title the insert generates, and a kept one is not flagged.
 *
 * The walk half: the commit prelude, `titleSetFacts`, `previewListingTitle`
 * and `addCustomCard` all report the insert's name only when the insert-level
 * row carries the NB insert ROLE — never by its level or its name.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";
import { assessNewCardListing, type ListingSetContext } from "./features/listingInputs";
import { MAX_LISTING_SHORT_NAME_LENGTH } from "./listingShortName";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(`NEO-335: this test file must not reach the network: ${String(url)}`);
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_shortname_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_shortname_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;
type Ids = {
  sportId: Id<"selectorOptions">;
  setNameId: Id<"selectorOptions">;
  leafId: Id<"selectorOptions">;
};

/** Long enough that every card's title core is cut with the full names. */
const LONG_SET_NAME =
  "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box Hobby Exclusive";
const FEATURES = { manufacturer: "Topps", season: "2026" };

/**
 * sport › setName › variantType (insert-typed) › insert (the leaf).
 * `isInsert` is the insert row's NB role; `setNameMetadata` lands on the set.
 */
async function seedTree(
  t: T,
  opts: {
    setName?: string;
    insertName?: string;
    isInsert?: boolean;
    setNameMetadata?: Record<string, unknown>;
  } = {},
): Promise<Ids> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: opts.setName ?? LONG_SET_NAME,
      platformData: {},
      features: FEATURES,
      ...(opts.setNameMetadata ? { metadata: opts.setNameMetadata } : {}),
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const typeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Inserts",
      platformData: {},
      features: FEATURES,
      metadata: { variantRole: "insert" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: opts.insertName ?? "Hologram Heroes",
      platformData: {},
      features: FEATURES,
      ...(opts.isInsert === undefined ? {} : { metadata: { isInsert: opts.isInsert } }),
      parentId: typeId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, setNameId, leafId };
  });
}

/** A SportLots-only card: no BSC ref, so nothing is queued for a team lookup. */
function card(opts: { cardNumber: string; listingTitleKept?: string }) {
  return {
    cardNumber: opts.cardNumber,
    cardName: `Card ${opts.cardNumber}`,
    teams: [],
    players: [],
    platformData: { sportlots: { ref: `SL-${opts.cardNumber}` } },
    ...(opts.listingTitleKept !== undefined ? { listingTitleKept: opts.listingTitleKept } : {}),
  };
}

function commit(
  t: T,
  ids: Ids,
  cards: ReturnType<typeof card>[],
  listingShortName?: string,
) {
  return t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
    selectorOptionId: ids.leafId,
    sportId: ids.sportId,
    cards,
    ...(listingShortName !== undefined ? { listingShortName } : {}),
  });
}

async function rowsByNumber(t: T, leafId: Id<"selectorOptions">) {
  const rows: Array<Doc<"cardChecklist">> = await t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
      .collect(),
  );
  return new Map(rows.map((r) => [r.cardNumber, r]));
}

async function leafMetadata(t: T, ids: Ids) {
  return (await t.run(async (ctx) => ctx.db.get(ids.leafId)))?.metadata;
}

/** The set facts the Card titles step opens with — the server's own query. */
async function setFacts(t: T, ids: Ids): Promise<ListingSetContext> {
  return t.query(internal.listingTitleContext.titleSetFacts, {
    selectorOptionId: ids.leafId,
    sportId: ids.sportId,
  });
}

/** The title the step SHOWS for card #n, with the operator's draft short name. */
async function shownTitle(t: T, ids: Ids, cardNumber: string, draft?: string) {
  const facts = await setFacts(t, ids);
  return assessNewCardListing(
    { cardNumber },
    { ...facts, ...(draft !== undefined ? { listingShortName: draft } : {}) },
    { playerNames: [] },
  ).assessment;
}

async function settle(t: T) {
  await drainScheduled(t);
  await cancelScheduled(t);
}

describe("commitCardChecklist — the batch's short name for titles (NEO-335)", () => {
  test("written onto the leaf BEFORE the chunks: the kept title regenerates identically and is not flagged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { isInsert: true });
    const shown = await shownTitle(t, ids, "1", "Topps Sapphire");
    // The premise: with the full names the core is cut, the short name fixes it.
    expect((await shownTitle(t, ids, "1")).coreFits).toBe(false);
    expect(shown.shortNameUsed).toBe(true);
    expect(shown.title).toContain("Topps Sapphire");

    await commit(t, ids, [card({ cardNumber: "1", listingTitleKept: shown.title })], "  Topps Sapphire ");

    expect(await leafMetadata(t, ids)).toEqual({ isInsert: true, listingShortName: "Topps Sapphire" });
    const row = (await rowsByNumber(t, ids.leafId)).get("1")!;
    expect(row.listingTitle).toBe(shown.title);
    expect(row.listingTitleTruncated).toBeUndefined();
    await settle(t);
  });

  test("control: the same kept title WITHOUT the short name is not what the server generates, so it is flagged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { isInsert: true });
    const shown = await shownTitle(t, ids, "1", "Topps Sapphire");

    await commit(t, ids, [card({ cardNumber: "1", listingTitleKept: shown.title })]);

    expect(await leafMetadata(t, ids)).toEqual({ isInsert: true });
    const row = (await rowsByNumber(t, ids.leafId)).get("1")!;
    expect(row.listingTitle).not.toBe(shown.title);
    expect(row.listingTitleTruncated).toBe(true);
    await settle(t);
  });

  test("every card of the batch is titled with it, not only the first chunk's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { isInsert: true });
    await commit(
      t,
      ids,
      ["1", "2", "3"].map((n) => card({ cardNumber: n })),
      "Topps Sapphire",
    );
    const rows = await rowsByNumber(t, ids.leafId);
    for (const n of ["1", "2", "3"]) {
      expect(rows.get(n)!.listingTitle).toBe((await shownTitle(t, ids, n)).title);
      expect(rows.get(n)!.listingTitle).toContain("Topps Sapphire");
    }
    await settle(t);
  });

  test("a short name already on an ancestor is used with no batch arg", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, {
      isInsert: true,
      setNameMetadata: { listingShortName: "Topps Sapphire" },
    });
    expect((await setFacts(t, ids)).listingShortName).toBe("Topps Sapphire");
    const shown = await shownTitle(t, ids, "1");
    expect(shown.shortNameUsed).toBe(true);

    await commit(t, ids, [card({ cardNumber: "1", listingTitleKept: shown.title })]);
    const row = (await rowsByNumber(t, ids.leafId)).get("1")!;
    expect(row.listingTitle).toBe(shown.title);
    expect(row.listingTitleTruncated).toBeUndefined();
    // The leaf was not written: the commit only writes what it was sent.
    expect(await leafMetadata(t, ids)).toEqual({ isInsert: true });
    await settle(t);
  });

  test.each([
    ["over the cap", "s".repeat(MAX_LISTING_SHORT_NAME_LENGTH + 1), /at most 60 characters/],
    ["a line break", "Topps\nSapphire", /line breaks or control characters/],
    ["a zero-width character", "Topps​Sapphire", /zero-width or invisible/],
  ])("%s refuses the WHOLE commit before anything is written", async (_label, shortName, message) => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { isInsert: true });
    await expect(
      commit(t, ids, [card({ cardNumber: "1" }), card({ cardNumber: "2" })], shortName),
    ).rejects.toThrow(message);
    expect((await rowsByNumber(t, ids.leafId)).size).toBe(0);
    expect(await leafMetadata(t, ids)).toEqual({ isInsert: true });
    await settle(t);
  });

  test("a blank short name is no answer: nothing is written to the leaf, and nothing is cleared", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { isInsert: true });
    await t.run(async (ctx) =>
      ctx.db.patch(ids.leafId, { metadata: { isInsert: true, listingShortName: "Stored" } }),
    );
    await commit(t, ids, [card({ cardNumber: "1" })], "   ");
    expect(await leafMetadata(t, ids)).toEqual({ isInsert: true, listingShortName: "Stored" });
    await settle(t);
  });
});

describe("every title walk reports the insert's name only on the insert ROLE (NEO-335)", () => {
  /** A short set name, so the insert's name fits in the core. */
  const SHORT = { setName: "Score", insertName: "Dugout Collection" };

  test.each([
    ["with the role", true, true],
    ["without the role", undefined, false],
    ["with the role explicitly false", false, false],
  ])("titleSetFacts, %s", async (_label, isInsert, expected) => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { ...SHORT, isInsert });
    const facts = await setFacts(t, ids);
    if (expected) {
      expect(facts.insertNameValue).toBe("Dugout Collection");
      expect(facts.insertIsRole).toBe(true);
    } else {
      expect(facts.insertNameValue).toBeUndefined();
      expect(facts.insertIsRole).toBeUndefined();
    }
  });

  test.each([
    ["with the role", true, true],
    ["without the role", undefined, false],
  ])("the commit prelude, %s", async (_label, isInsert, expected) => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { ...SHORT, isInsert });
    const prelude = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(internal.selectorOptions.commitCardChecklistPrelude, {
        selectorOptionId: ids.leafId,
        sportId: ids.sportId,
        playerNames: [],
        teamNames: [],
      });
    expect(prelude.insertNameValue).toBe(expected ? "Dugout Collection" : undefined);
    expect(prelude.insertIsRole).toBe(expected ? true : undefined);
  });

  test.each([
    ["with the role", true, true],
    ["without the role", undefined, false],
  ])("the commit's insert (prelude → chunk), %s", async (_label, isInsert, expected) => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { ...SHORT, isInsert });
    await commit(t, ids, [card({ cardNumber: "7" })]);
    const title = (await rowsByNumber(t, ids.leafId)).get("7")!.listingTitle!;
    expect(title.includes("Dugout Collection")).toBe(expected);
    expect(title).toBe((await shownTitle(t, ids, "7")).title);
    await settle(t);
  });

  test.each([
    ["with the role", true, true],
    ["without the role", undefined, false],
  ])("addCustomCard and previewListingTitle (findAncestorLabels), %s", async (_label, isInsert, expected) => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { ...SHORT, isInsert });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: ids.leafId,
      cardNumber: "9",
      cardName: "Card 9",
    });
    const row = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(row!.listingTitle!.includes("Dugout Collection")).toBe(expected);

    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, { cardId });
    expect(preview.inputs.insertName).toBe(expected ? "Dugout Collection" : undefined);
    // Regenerate offers exactly what creation wrote.
    expect(preview.title).toBe(row!.listingTitle);
    await settle(t);
  });

  test("previewListingTitle reads a short name set AFTER the card was created (Regenerate)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, { isInsert: true });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const cardId = await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: ids.leafId,
      cardNumber: "9",
      cardName: "Card 9",
    });
    const before = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(before!.listingTitleTruncated).toBe(true);

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionListingShortName, {
      id: ids.setNameId,
      listingShortName: "Topps Sapphire",
    });
    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, { cardId });
    expect(preview.inputs.setShortName).toBe("Topps Sapphire");
    expect(preview.title).toContain("Topps Sapphire");
    // Write-once: the stored title is not touched by the edit.
    expect((await t.run(async (ctx) => ctx.db.get(cardId)))!.listingTitle).toBe(before!.listingTitle);
    await settle(t);
  });

  test("the prelude reports a parallel leaf's own value only on the parallel ROLE", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t, SHORT);
    const run = () =>
      t
        .withIdentity(ADMIN_IDENTITY)
        .mutation(internal.selectorOptions.commitCardChecklistPrelude, {
          selectorOptionId: ids.leafId,
          sportId: ids.sportId,
          playerNames: [],
          teamNames: [],
        });
    expect((await run()).parallelLeafValue).toBeUndefined();
    await t.run(async (ctx) => ctx.db.patch(ids.leafId, { metadata: { isParallel: true } }));
    expect((await run()).parallelLeafValue).toBe("Dugout Collection");
  });
});
