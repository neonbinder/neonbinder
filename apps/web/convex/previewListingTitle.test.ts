/**
 * NEO-101 — `selectorOptions.previewListingTitle`.
 *
 * The query behind the card detail panel's **Regenerate** button and its
 * source-field chips: what the generator WOULD title this stored card today,
 * plus the inputs it used. Read-only; it stores nothing.
 *
 * The load-bearing test here is the last one. `previewListingTitle` resolves
 * its inputs by MIRRORING `commitCardChecklistChunk`'s insert branch by hand
 * (different starting point — a stored row's own `features` versus a merged
 * snapshot computed for a card that does not exist yet — so the two cannot
 * share code without inventing a parameter object shaped like the thing being
 * built). Two hand-kept copies drift, so the contract is pinned as an
 * assertion: preview a freshly committed card and the title must come back
 * byte-identical to the one the commit stored.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

async function seedSubtree(t: ReturnType<typeof convexTest>) {
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
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Chrome",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return { sportId, setNameId, variantTypeId };
  });
}

async function insertCard(
  t: ReturnType<typeof convexTest>,
  variantTypeId: Id<"selectorOptions">,
  card: Record<string, unknown>,
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId: variantTypeId,
      cardNumber: "50",
      cardName: "A Card",
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
      ...card,
    } as never),
  );
}

describe("previewListingTitle (NEO-101)", () => {
  test("resolves player names, the set-name ancestor, and the row's own flags", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedSubtree(t);

    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Elly De La Cruz",
        nameNormalized: "cruz elly de la",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const cardId = await insertCard(t, variantTypeId, {
      cardNumber: "50",
      playerIds: [playerId],
      isRookie: true,
      features: { season: "2024", manufacturer: "Topps", parallelName: "Base" },
    });

    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, {
      cardId,
    });

    // NEO-101: the sport ancestor and the second "Rookie" spelling are part
    // of the packed title now, and both are resolved by THIS query.
    expect(preview.title).toBe(
      "2024 Topps Chrome Elly De La Cruz #50 RC Rookie Baseball",
    );
    expect(preview.coreFits).toBe(true);
    expect(preview.dropped).toEqual([]);
    // The chips the panel renders come straight off this.
    expect(preview.inputs).toMatchObject({
      cardNumber: "50",
      playerNames: ["Elly De La Cruz"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      parallelName: "Base",
      isRookie: true,
      teamNames: [],
      sport: "Baseball",
    });
  });

  test("falls back to pendingPlayerNames when a custom card has no resolved players", async () => {
    // A hand-added card carries the names the operator TYPED until the next
    // sync reconciles them into `players` rows. Those are the operator's
    // answer, so the preview uses them — exactly as `addCustomCard` does when
    // it generates the title in the first place.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedSubtree(t);

    const cardId = await insertCard(t, variantTypeId, {
      cardNumber: "7",
      isCustom: true,
      pendingPlayerNames: ["Nobody In The Players Table"],
      features: { season: "2024", manufacturer: "Topps" },
    });

    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, {
      cardId,
    });
    expect(preview.inputs.playerNames).toEqual(["Nobody In The Players Table"]);
    expect(preview.title).toBe(
      "2024 Topps Chrome Nobody In The Players Table #7 Baseball",
    );
  });

  test("carries printRun, cardVariation and the feature flags into the title", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedSubtree(t);

    const cardId = await insertCard(t, variantTypeId, {
      cardNumber: "300b",
      printRun: 25,
      cardVariation: "Image Variation",
      isRelic: true,
      features: {
        season: "2024",
        manufacturer: "Topps",
        parallelName: "Gold",
        autographed: "On Card",
        shortPrint: "SP",
      },
    });

    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, {
      cardId,
    });
    expect(preview.title).toBe(
      "2024 Topps Chrome #300b AUTO RELIC Gold /25 Image Variation SP Baseball",
    );
    expect(preview.inputs.printRun).toBe(25);
    expect(preview.inputs.cardVariation).toBe("Image Variation");
  });

  test("reports coreFits: false and the dropped tokens when the row cannot fit", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedSubtree(t);

    const hugeName =
      "An Absurdly Long Player Full Name That Alone Exceeds The Entire Title Budget";
    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: hugeName,
        nameNormalized: hugeName.toLowerCase(),
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const cardId = await insertCard(t, variantTypeId, {
      cardNumber: "99999",
      playerIds: [playerId],
      isRookie: true,
      features: { season: "2024", manufacturer: "Topps", autographed: "On Card" },
    });

    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, {
      cardId,
    });
    expect(preview.coreFits).toBe(false);
    // "skip, don't stop", end to end: the 5-character " AUTO" did not fit, the
    // 3-character " RC" behind it did, and the result lands exactly on the cap.
    expect(preview.dropped).toEqual(["AUTO", "Rookie", "Baseball"]);
    expect(preview.title).toBe(
      "2024 Topps Chrome An Absurdly Long Player Full Name That Alone Exceeds #99999 RC",
    );
    expect(preview.title.length).toBe(80);
    expect(preview.title).not.toContain("…");
  });

  test("de-dupes and bounds the playerIds fan-out", async () => {
    // `playerIds` is unvalidated on the row — `updateCard` takes it as full
    // replacement with no cap and no de-duplication, unlike `teamOnCardIds`.
    // A repeated id must not be read (or printed) twice, and a long array must
    // not turn one query call into an unbounded sequential read walk.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedSubtree(t);

    const playerIds = await t.run(async (ctx) => {
      const ids: Id<"players">[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push(
          await ctx.db.insert("players", {
            name: `Player ${String(i).padStart(2, "0")}`,
            nameNormalized: `player ${i}`,
            sportId,
            lastUpdated: Date.now(),
          }),
        );
      }
      return ids;
    });

    // A repeated id resolves once.
    const dupeCardId = await insertCard(t, variantTypeId, {
      cardNumber: "1",
      playerIds: [playerIds[0], playerIds[0], playerIds[1], playerIds[0]],
    });
    const dupePreview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId: dupeCardId },
    );
    expect(dupePreview.inputs.playerNames).toEqual(["Player 00", "Player 01"]);

    // A 20-id array reads at most the documented bound.
    const wideCardId = await insertCard(t, variantTypeId, {
      cardNumber: "2",
      playerIds,
    });
    const widePreview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId: wideCardId },
    );
    expect(widePreview.inputs.playerNames).toHaveLength(12);
    expect(widePreview.inputs.playerNames[0]).toBe("Player 00");
    expect(widePreview.title.length).toBeLessThanOrEqual(80);
  });

  test("resolves team names from teamOnCardIds, deduped and bounded", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedSubtree(t);

    const teamIds = await t.run(async (ctx) => {
      const ids: Id<"teams">[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push(
          await ctx.db.insert("teams", {
            name: `Team ${String(i).padStart(2, "0")}`,
            nameNormalized: `team ${i}`,
            sportId,
            lastUpdated: Date.now(),
          }),
        );
      }
      return ids;
    });

    const dupeCardId = await insertCard(t, variantTypeId, {
      cardNumber: "1",
      teamOnCardIds: [teamIds[0], teamIds[0], teamIds[1]],
    });
    const dupePreview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId: dupeCardId },
    );
    expect(dupePreview.inputs.teamNames).toEqual(["Team 00", "Team 01"]);
    expect(dupePreview.inputs.sport).toBe("Baseball");

    // 12 ids, capped at MAX_CARD_TEAMS — the same bound `updateCard` enforces
    // on the write path, here for rows written before that validation landed.
    const wideCardId = await insertCard(t, variantTypeId, {
      cardNumber: "2",
      teamOnCardIds: teamIds,
    });
    const widePreview = await asAdmin.query(
      api.selectorOptions.previewListingTitle,
      { cardId: wideCardId },
    );
    expect(widePreview.inputs.teamNames).toHaveLength(8);
    expect(widePreview.title.length).toBeLessThanOrEqual(80);
  });

  test("falls back to pendingTeamNames for a hand-added card", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedSubtree(t);

    const cardId = await insertCard(t, variantTypeId, {
      cardNumber: "9001",
      isCustom: true,
      pendingTeamNames: ["Savannah Bananas"],
      features: { season: "2024", manufacturer: "Topps" },
    });

    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, {
      cardId,
    });
    expect(preview.inputs.teamNames).toEqual(["Savannah Bananas"]);
    expect(preview.title).toBe(
      "2024 Topps Chrome #9001 Savannah Bananas Baseball",
    );
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedSubtree(t);
    const cardId = await insertCard(t, variantTypeId, {});

    await expect(
      t.withIdentity({ subject: "some_user" }).query(
        api.selectorOptions.previewListingTitle,
        { cardId },
      ),
    ).rejects.toThrow();
    await expect(
      t.query(api.selectorOptions.previewListingTitle, { cardId }),
    ).rejects.toThrow();
  });

  test("a missing card is refused rather than previewed as a blank", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedSubtree(t);
    const cardId = await insertCard(t, variantTypeId, {});
    await t.run(async (ctx) => ctx.db.delete(cardId));

    await expect(
      asAdmin.query(api.selectorOptions.previewListingTitle, { cardId }),
    ).rejects.toThrow(/no such card/);
  });

  test("reproduces EXACTLY what commitCardChecklist's insert branch stored", async () => {
    // The contract that keeps the two hand-kept input mappings in step. If
    // this breaks, one of them changed without the other — see the note on
    // `previewListingTitle` in selectorOptions.ts.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, variantTypeId } = await seedSubtree(t);
    await asAdmin.mutation(api.players.findOrCreate, {
      name: "Julio Rodriguez",
      sportId,
    });
    // NEO-220: settle the enrichment that creation schedules BEFORE the test
    // goes on. Drained here rather than at the end of the test on purpose —
    // `commitCardChecklist` below schedules its own BSC team backfill, and a
    // drain after it would pull that outbound call forward into this test
    // instead of leaving it exactly as it was. See drain-scheduled.ts.
    await drainScheduled(t);

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: variantTypeId,
      sportId,
      cards: [
        {
          cardNumber: "300b",
          cardName: "Julio Rodriguez",
          team: undefined,
          teams: [],
          players: ["Julio Rodriguez"],
          attributes: ["RC"],
          isRookie: true,
          isRelic: false,
          printRun: 99,
          autographType: "On-Card",
          cardVariation: "Image Variation",
          platformData: { bsc: { ref: "bsc-300b" } },
          unmatched: undefined,
        },
      ],
    });

    const [card] = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", variantTypeId),
        )
        .collect(),
    );

    const preview = await asAdmin.query(api.selectorOptions.previewListingTitle, {
      cardId: card._id,
    });
    expect(preview.title).toBe(card.listingTitle);
  });
});
