/**
 * NEO-358 — `cardTeamLinks`, the team → cards index. (The armed
 * `backfillCardSearchFields` that was tested here ran and was retired in
 * NEO-363, when `listingTitle` and `sportId` became required.)
 *
 * The index is derived from `cardChecklist.teamOnCardIds`; these cases drive
 * the real writers (`addCustomCard`, `updateCard`, the commit chunk's insert
 * and its operator fill, `applyBscTeamResolution`, `deleteCard`) and hold the
 * rows against the card each time. `cardTeamLinks.pin.test.ts` pins that no
 * writer is missed.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { planCardTeamLinks } from "./cardTeamLinks";
import { normalizeEntityName } from "../lib/entities/normalize-name";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "user_admin", role: "admin" };
const NOW = 1_700_000_000_000;
type T = ReturnType<typeof convexTest>;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seed(t: T) {
  return t.run(async (ctx) => {
    const row = (
      level: "sport" | "year" | "manufacturer" | "setName" | "variantType",
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
    const base = await row("variantType", "Base", set);
    const leagueId = await ctx.db.insert("leagues", {
      level: "major",
      name: "Major League Baseball",
      nameNormalized: "baseball league major",
      sportId: sport,
      lastUpdated: NOW,
    });
    const team = (name: string) =>
      ctx.db.insert("teams", {
        name,
        nameNormalized: normalizeEntityName(name),
        sportId: sport,
        leagueId,
        lastUpdated: NOW,
      });
    const padres = await team("San Diego Padres");
    const mets = await team("New York Mets");
    return { sport, set, base, padres, mets };
  });
}

/** The team ids the index holds for a card, sorted. */
const linked = (t: T, cardId: Id<"cardChecklist">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("cardTeamLinks")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", cardId))
        .collect()
    )
      .map((r) => r.teamId as string)
      .sort(),
  );

describe("planCardTeamLinks", () => {
  const row = (id: string, teamId: string) => ({
    _id: id as Id<"cardTeamLinks">,
    teamId: teamId as Id<"teams">,
  });
  test("one row per team, duplicates and stale rows removed", () => {
    expect(
      planCardTeamLinks(
        [row("l1", "a"), row("l2", "a"), row("l3", "z")],
        ["a", "b", "b"] as Array<Id<"teams">>,
      ),
    ).toEqual({ toDelete: ["l2", "l3"], toInsert: ["b"] });
  });
  test("an empty or absent list removes every row", () => {
    expect(planCardTeamLinks([row("l1", "a")], undefined)).toEqual({
      toDelete: ["l1"],
      toInsert: [],
    });
  });
});

describe("every teamOnCardIds writer keeps the index", () => {
  test("addCustomCard, then updateCard (change, then clear), then deleteCard", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const admin = t.withIdentity(ADMIN);
    const id = await admin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: s.base,
      cardNumber: "1",
      cardName: "Padres Leaders",
      teamOnCardIds: [s.padres],
    });
    expect(await linked(t, id)).toEqual([s.padres]);

    await admin.mutation(api.selectorOptions.updateCard, {
      id,
      teamOnCardIds: [s.mets, s.padres],
    });
    expect(await linked(t, id)).toEqual([s.mets, s.padres].sort());

    await admin.mutation(api.selectorOptions.updateCard, { id, teamOnCardIds: [] });
    expect(await linked(t, id)).toEqual([]);

    await admin.mutation(api.selectorOptions.updateCard, { id, teamOnCardIds: [s.mets] });
    await admin.mutation(api.selectorOptions.deleteCard, { id });
    const left = await t.run((ctx) => ctx.db.query("cardTeamLinks").collect());
    expect(left).toEqual([]);
  });

  test("an updateCard that does not send teams leaves the index alone", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const admin = t.withIdentity(ADMIN);
    const id = await admin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: s.base,
      cardNumber: "1",
      cardName: "Padres Leaders",
      teamOnCardIds: [s.padres],
    });
    await admin.mutation(api.selectorOptions.updateCard, { id, cardName: "Renamed" });
    expect(await linked(t, id)).toEqual([s.padres]);
  });

  test("the commit chunk: an inserted card's teams, and an operator's fill of an empty row", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const existing = await t.run((ctx) =>
      insertTestCard(ctx, {
        selectorOptionId: s.base,
        cardNumber: "2",
        cardName: "Card 2",
        listingTitle: "Card 2",
        platformData: {},
        sortOrder: 2,
        lastUpdated: NOW,
      }),
    );
    const result = await t.mutation(internal.selectorOptions.commitCardChecklistChunk, {
      selectorOptionId: s.base,
      sportValue: "Baseball",
      setNameValue: "Chrome",
      cards: [
        {
          cardNumber: "1",
          cardName: "Card 1",
          teamOnCardIds: [s.padres],
          platformData: {},
          sortOrder: 1,
          playerNames: [],
          teamNames: ["San Diego Padres"],
        },
        {
          cardNumber: "2",
          cardName: "Card 2",
          existingId: existing,
          operatorTeamIds: [s.mets],
          platformData: {},
          sortOrder: 2,
          playerNames: [],
          teamNames: [],
        },
      ],
    });
    const inserted = result.storedIds.find((id) => id !== existing)!;
    expect(await linked(t, inserted)).toEqual([s.padres]);
    expect(await linked(t, existing)).toEqual([s.mets]);
  });

  test("applyBscTeamResolution links the resolved team and its index row", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await t.run((ctx) =>
      insertTestCard(ctx, {
        selectorOptionId: s.base,
        cardNumber: "3",
        cardName: "Card 3",
        listingTitle: "Card 3",
        platformData: { bsc: { ref: "bsc-3" } },
        sortOrder: 3,
        lastUpdated: NOW,
      }),
    );
    await t.mutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: card,
      rawTeamName: "San Diego Padres",
      teamNames: ["San Diego Padres"],
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(card))!.teamOnCardIds)).toEqual([
      s.padres,
    ]);
    expect(await linked(t, card)).toEqual([s.padres]);
  });
});

describe("backfillCardTeamLinks", () => {
  test("dry run reports, armed run writes, a second run is a no-op", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const card = await t.run((ctx) =>
      insertTestCard(ctx, {
        selectorOptionId: s.base,
        cardNumber: "1",
        cardName: "Card 1",
        teamOnCardIds: [s.padres, s.mets, s.padres],
        platformData: {},
        sortOrder: 1,
        lastUpdated: NOW,
      }),
    );
    const dry = await t.action(internal.cardTeamLinks.backfillCardTeamLinks, {});
    expect(dry).toMatchObject({ armed: false, complete: true, cardsChanged: 1, rowsInserted: 2 });
    expect(await linked(t, card)).toEqual([]);

    const refused = await t.action(internal.cardTeamLinks.backfillCardTeamLinks, {
      confirm: "BACKFILL",
    });
    expect(refused.armed).toBe(false);
    expect(refused.message).toMatch(/not armed/);

    vi.stubEnv("ALLOW_CARD_TEAM_LINKS_BACKFILL", "1");
    const armed = await t.action(internal.cardTeamLinks.backfillCardTeamLinks, {
      confirm: "BACKFILL",
    });
    expect(armed).toMatchObject({ armed: true, cardsChanged: 1, rowsInserted: 2 });
    expect(await linked(t, card)).toEqual([s.mets, s.padres].sort());

    const again = await t.action(internal.cardTeamLinks.backfillCardTeamLinks, {
      confirm: "BACKFILL",
    });
    expect(again).toMatchObject({ cardsChanged: 0, rowsInserted: 0, rowsDeleted: 0 });
  });
});
