/**
 * NEO-358 — the PR-preview E2E seed carries every field the collection reads.
 *
 * What a preview holds after the seed, and how it got there:
 *  1. `e2e-seed-reset.sh` drains the deployment and imports the reference
 *     bundle (scripts/reference-seed). The bundle is EIGHT tables: the sport
 *     rows of `selectorOptions` plus leagues, franchises, teams, teamAliases,
 *     players, playerAliases and playerSports. It carries no card, no year,
 *     brand, set or variant row, and no derived table; `checkFiles` refuses a
 *     bundle that does (scripts/reference-seed/pipeline.test.mjs, and the
 *     reference-seed `derived fields` test beside it).
 *  2. The Playwright `setup` project then builds 2024 Topps Chrome through
 *     the app: the Base and Future Stars checklists are committed by
 *     `commitCardChecklistChunk`, and Gold Wave Refractors is built from Base
 *     by `insertParallelCardsPage`. Both mint cards through
 *     `cardRowCreate.insertCardRow`.
 *
 * So the derived fields come from the writers, not from the import, and need
 * no backfill and no env flag on the preview. This file runs those two writers
 * the way the seed does, on a catalogue shaped like a fresh import (variant
 * rows with NO stored counts, teams and players as imported rows), and holds
 * every field the collection reads: `cardChecklist.sportId`, a non-blank
 * `listingTitle`, `cardTeamLinks` and `cardPlayerLinks` rows, and both stored
 * counts on each variant row, equal to a recount.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { recountCards } from "./cardCounts";
import { normalizeEntityName } from "../lib/entities/normalize-name";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const NOW = 1_700_000_000_000;
type T = ReturnType<typeof convexTest>;

/** The catalogue as the seed leaves it before the first commit. */
async function seedLikeAFreshImport(t: T) {
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
    // Imported (reference bundle): the sport row, a league, teams, players.
    const sport = await row("sport", "Baseball");
    const leagueId = await ctx.db.insert("leagues", {
      level: "major",
      name: "Major League Baseball",
      nameNormalized: "baseball league major",
      sportId: sport,
      lastUpdated: NOW,
    });
    const team = (location: string, name: string) =>
      ctx.db.insert("teams", {
        location,
        name,
        nameNormalized: normalizeEntityName(`${location} ${name}`),
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
    const padres = await team("San Diego", "Padres");
    const mets = await team("New York", "Mets");
    const tatis = await player("Fernando Tatis Jr.");
    const alonso = await player("Pete Alonso");

    // Synced by the setup project (the selector sync): no stored counts.
    const year = await row("year", "2024", sport);
    const brand = await row("manufacturer", "Topps", year);
    const set = await row("setName", "Topps Chrome", brand);
    const base = await row("variantType", "Base", set);
    const parallelType = await row("variantType", "Parallel", set);
    const goldWave = await row("insert", "Gold Wave Refractors", parallelType);
    await ctx.db.patch(set, { children: [base, parallelType] });
    await ctx.db.patch(parallelType, { children: [goldWave] });
    return { sport, base, goldWave, padres, mets, tatis, alonso };
  });
}

type Seeded = Awaited<ReturnType<typeof seedLikeAFreshImport>>;

/** Every derived field the collection reads, for each card on `rowId`. */
async function derivedFieldsOn(t: T, rowId: Id<"selectorOptions">) {
  return t.run(async (ctx) => {
    const cards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", rowId))
      .collect();
    const out = [];
    for (const card of cards) {
      const teamLinks = await ctx.db
        .query("cardTeamLinks")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", card._id))
        .collect();
      const playerLinks = await ctx.db
        .query("cardPlayerLinks")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", card._id))
        .collect();
      out.push({
        cardNumber: card.cardNumber,
        sportId: card.sportId,
        titled: (card.listingTitle ?? "").trim().length > 0,
        teams: teamLinks.map((l) => l.teamId).sort(),
        teamOnCardIds: [...(card.teamOnCardIds ?? [])].sort(),
        players: playerLinks.map((l) => l.playerId).sort(),
      });
    }
    const variant = (await ctx.db.get(rowId))!;
    return {
      cards: out.sort((a, b) => a.cardNumber.localeCompare(b.cardNumber)),
      stored: {
        cardCount: variant.cardCount,
        nonVariationCardCount: variant.nonVariationCardCount,
      },
      recount: await recountCards(ctx, rowId),
    };
  });
}

function expectFullyDerived(
  s: Seeded,
  got: Awaited<ReturnType<typeof derivedFieldsOn>>,
  n: number,
) {
  expect(got.cards).toHaveLength(n);
  for (const card of got.cards) {
    expect(card.sportId, card.cardNumber).toBe(s.sport);
    expect(card.titled, card.cardNumber).toBe(true);
    // The team index mirrors the card's teams exactly.
    expect(card.teams, card.cardNumber).toEqual(card.teamOnCardIds);
    expect(card.teams.length, card.cardNumber).toBeGreaterThan(0);
    expect(card.players.length, card.cardNumber).toBeGreaterThan(0);
  }
  expect(got.stored).toEqual({ cardCount: n, nonVariationCardCount: n });
  expect(got.stored).toEqual(got.recount);
}

describe("the E2E seed's write paths carry every derived field", () => {
  test("the Base commit, then Gold Wave built from Base, on a freshly imported catalogue", async () => {
    const t = convexTest(schema, modules);
    const s = await seedLikeAFreshImport(t);

    // ── the Base checklist, committed as the setup project commits it ──
    await t.mutation(internal.selectorOptions.commitCardChecklistChunk, {
      selectorOptionId: s.base,
      sportValue: "Baseball",
      setNameValue: "Topps Chrome",
      cards: [
        {
          cardNumber: "1",
          cardName: "Fernando Tatis Jr.",
          playerIds: [s.tatis],
          teamOnCardIds: [s.padres],
          platformData: { bsc: { ref: "bsc-1" }, sportlots: { ref: "sl-1" } },
          sortOrder: 1,
          playerNames: ["Fernando Tatis Jr."],
          teamNames: ["San Diego Padres"],
        },
        {
          cardNumber: "2",
          cardName: "Pete Alonso",
          playerIds: [s.alonso],
          teamOnCardIds: [s.mets],
          platformData: { bsc: { ref: "bsc-2" }, sportlots: { ref: "sl-2" } },
          sortOrder: 2,
          playerNames: ["Pete Alonso"],
          teamNames: ["New York Mets"],
        },
      ],
    });
    const base = await derivedFieldsOn(t, s.base);
    expectFullyDerived(s, base, 2);

    // ── Gold Wave Refractors, built from Base (NEO-321) ──
    const sources = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", s.base))
        .collect(),
    );
    const built = await t.mutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
      parallelId: s.goldWave,
      sourceId: s.base,
      copies: sources.map((card) => ({
        sourceCardId: card._id,
        expect: {
          cardNumber: card.cardNumber,
          cardName: card.cardName,
          // What the build's action reads (`namesOnCardOf`).
          namesOnCard: [
            ...(card.playerLinks ?? []).map((l) => l.nameOnCard),
            ...(card.pendingPlayerNames ?? []),
          ],
        },
        bsc: { ref: `gw-${card.cardNumber}` },
      })),
      remap: [],
    });
    expect(built).toMatchObject({ changed: false, missing: 0, skippedChangedSource: 0 });
    expect(built.created).toHaveLength(2);
    const goldWave = await derivedFieldsOn(t, s.goldWave);
    expectFullyDerived(s, goldWave, 2);
    // The copies carry the Base cards' teams and players.
    expect(goldWave.cards.map((c) => c.teams)).toEqual(base.cards.map((c) => c.teams));
    expect(goldWave.cards.map((c) => c.players)).toEqual(base.cards.map((c) => c.players));
  });
});
