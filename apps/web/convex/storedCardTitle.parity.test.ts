/**
 * NEO-358 — `previewListingTitle` (Regenerate) and `titleForStoredCard` (what
 * the armed `backfillCardSearchFields` writes) give the same answer.
 *
 * The preview's body was moved, unchanged, into `storedCardTitle.ts`; this
 * pins that the two stay one implementation across the shapes a stored card
 * comes in: resolved players and teams, a hand-added card's pending names, a
 * card under an insert and under a parallel of one, a card with a dangling
 * player id, a variation, and a core the generator has to cut. Each title is
 * also pinned as a literal, so a change to either side (or to the generator)
 * is seen here first. And a card born through the commit chunk stores the
 * title Regenerate would offer, so a backfilled title and an inserted one
 * agree.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { titleForStoredCard } from "./storedCardTitle";
import { normalizeEntityName } from "../lib/entities/normalize-name";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "user_admin", role: "admin" };
const NOW = 1_700_000_000_000;
type T = ReturnType<typeof convexTest>;
type Card = Doc<"cardChecklist">;

async function seed(t: T) {
  return t.run(async (ctx) => {
    const row = (
      level: Doc<"selectorOptions">["level"],
      value: string,
      parentId?: Id<"selectorOptions">,
      features?: Record<string, string>,
    ) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        ...(parentId ? { parentId } : {}),
        ...(features ? { features } : {}),
        platformData: {},
        children: [],
        lastUpdated: NOW,
      });
    const sport = await row("sport", "Baseball");
    const year = await row("year", "2024", sport);
    const brand = await row("manufacturer", "Topps", year);
    const set = await row("setName", "Topps Chrome", brand);
    const base = await row("variantType", "Base", set, { season: "2024", cardType: "Base" });
    const insertType = await row("variantType", "Insert", set);
    const insert = await row("insert", "Future Stars", insertType, {
      season: "2024",
      cardType: "Insert",
    });
    const parallel = await row("parallel", "Gold Refractor", insert, {
      season: "2024",
      cardType: "Parallel",
      parallelName: "Gold Refractor",
    });
    const leagueId = await ctx.db.insert("leagues", {
      level: "major",
      name: "Major League Baseball",
      nameNormalized: "baseball league major",
      sportId: sport,
      lastUpdated: NOW,
    });
    const mets = await ctx.db.insert("teams", {
      name: "Mets",
      location: "New York",
      nameNormalized: normalizeEntityName("New York Mets"),
      sportId: sport,
      leagueId,
      lastUpdated: NOW,
    });
    const player = (name: string) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: normalizeEntityName(name),
        sportId: sport,
        lastUpdated: NOW,
      });
    const gooden = await player("Dwight Gooden");
    const strawberry = await player("Darryl Strawberry");
    const gone = await player("Nobody At All");
    await ctx.db.delete(gone);

    const card = (selectorOptionId: Id<"selectorOptions">, cardNumber: string, extra: Partial<Card>) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId,
        cardNumber,
        cardName: `Card ${cardNumber}`,
        platformData: {},
        sortOrder: 0,
        lastUpdated: NOW,
        ...extra,
      });
    const cards = {
      resolved: await card(base, "16", {
        playerIds: [gooden, strawberry, gooden],
        teamOnCardIds: [mets],
        isRookie: true,
        printRun: 99,
        features: { season: "2024" },
      }),
      pending: await card(base, "17", {
        pendingPlayerNames: ["Doc Gooden"],
        pendingTeamNames: ["New York Mets"],
      }),
      underInsert: await card(insert, "FS-1", {
        playerIds: [gooden],
        features: { season: "2024", cardType: "Insert", autographed: "On Card" },
      }),
      underParallel: await card(parallel, "FS-2", {
        playerIds: [strawberry],
        features: { season: "2024", cardType: "Parallel", parallelName: "Gold Refractor" },
      }),
      dangling: await card(base, "18", { playerIds: [gone] }),
      variation: await card(base, "16", {
        playerIds: [gooden],
        cardVariation: "Image Variation",
      }),
      longCore: await card(base, "19", {
        pendingPlayerNames: [
          "Bartholomew Maximilian Fitzgerald-Worthington",
          "Bartholomew Maximilian Fitzgerald-Worthington",
        ],
      }),
    };
    return { sport, base, mets, gooden, cards };
  });
}

describe("previewListingTitle and titleForStoredCard", () => {
  test("give the same title, flags and inputs for every shape of stored card", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const titles: Record<string, string> = {};
    for (const [key, cardId] of Object.entries(s.cards)) {
      const preview = await t
        .withIdentity(ADMIN)
        .query(api.selectorOptions.previewListingTitle, { cardId });
      const stored = await t.run(async (ctx) => titleForStoredCard(ctx, (await ctx.db.get(cardId))!));
      expect(preview, key).toEqual({
        title: stored.title,
        coreFits: stored.coreFits,
        dropped: stored.dropped,
        inputs: stored.inputs,
      });
      titles[key] = preview.title;
    }
    // The literal titles, so drift on either side shows up here.
    expect(titles).toMatchInlineSnapshot(`
      {
        "dangling": "Topps Chrome #18 Baseball",
        "longCore": "Topps Chrome Bartholomew Maximilian Fitzgerald-Worthington & Bartholomew #19",
        "pending": "Topps Chrome Doc Gooden #17 New York Mets Baseball",
        "resolved": "2024 Topps Chrome Dwight Gooden & Darryl Strawberry #16 /99 RC New York Mets",
        "underInsert": "2024 Topps Chrome Future Stars Insert Dwight Gooden #FS-1 AUTO Baseball",
        "underParallel": "2024 Topps Chrome Future Stars Darryl Strawberry #FS-2 Gold Refractor Baseball",
        "variation": "Topps Chrome Dwight Gooden #16 Image Variation Baseball",
      }
    `);
  });

  test("a card born through the commit chunk stores the title Regenerate offers", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const result = await t.mutation(internal.selectorOptions.commitCardChecklistChunk, {
      selectorOptionId: s.base,
      sportValue: "Baseball",
      setNameValue: "Topps Chrome",
      cards: [
        {
          cardNumber: "20",
          cardName: "Card 20",
          playerIds: [s.gooden],
          teamOnCardIds: [s.mets],
          platformData: {},
          sortOrder: 20,
          playerNames: ["Dwight Gooden"],
          teamNames: ["New York Mets"],
        },
      ],
    });
    const cardId = result.storedIds[0];
    const stored = await t.run(async (ctx) => (await ctx.db.get(cardId))!);
    const preview = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.previewListingTitle, { cardId });
    expect(stored.listingTitle).toBe(preview.title);
  });
});
