/**
 * NEO-251 (security review) — the guards on the commit side of the roster
 * work, and one documented gap.
 *
 * Three separate things are pinned here because each is separately reachable by
 * a browser and none may assume another ran first:
 *
 *  1. `resolveChecklistEntities` and `commitCardChecklist` bound what a card
 *     CARRIES, not merely how many cards there are. `players` leaves an
 *     adapter, crosses an operator's browser and comes back in as a bare
 *     `v.array(v.string())`; the sibling assertions for the review diff live in
 *     `diffChecklistAgainstExisting.test.ts`.
 *  2. The commit refuses a card still carrying `playersConflict`. The modal
 *     strips it; this is the proof rather than the trust.
 *  3. `normalizePlayerName` DOES fold diacritics (NEO-253), so SportLots' "José
 *     Ramírez" resolves to BSC's existing "Jose Ramirez" row instead of minting
 *     a second person. This started life as a tripwire on the opposite
 *     behaviour; it is now the regression test for the fix.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { nameKey } from "../lib/cards/card-name";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo251_guards",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo251_guards",
  name: "Admin User",
  role: "admin",
};

async function seedTree(t: ReturnType<typeof convexTest>): Promise<{
  sportId: Id<"selectorOptions">;
  leafId: Id<"selectorOptions">;
}> {
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
      value: "Test Set",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

function card(opts: {
  cardNumber?: string;
  players?: string[];
  teams?: string[];
  playersConflict?: { bsc: string[]; sportlots: string[] };
}) {
  return {
    cardNumber: opts.cardNumber ?? "1",
    cardName: "Card One",
    players: opts.players ?? [],
    teams: opts.teams ?? [],
    attributes: [],
    platformData: { bsc: { ref: "bsc-1" } },
    ...(opts.playersConflict
      ? { playersConflict: opts.playersConflict }
      : {}),
  };
}

const tooMany = Array.from({ length: 21 }, (_, i) => `Player ${i}`);
const tooLong = "Z".repeat(121);

describe("card name bounds at every entry point (NEO-251)", () => {
  test("resolveChecklistEntities refuses a card with too many players", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await expect(
      t
        .withIdentity(ADMIN)
        .action(api.selectorOptions.resolveChecklistEntities, {
          selectorOptionId: leafId,
          sportId,
          cards: [card({ players: tooMany })],
        }),
    ).rejects.toThrow(/20-player limit/);
  });

  test("commitCardChecklist refuses a card with too many players", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await expect(
      t.withIdentity(ADMIN).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ players: tooMany })],
      }),
    ).rejects.toThrow(/20-player limit/);
  });

  /**
   * Reported by LENGTH, never by echoing the name: this message reaches Sentry
   * and the browser console through Convex's error path, and the text is
   * marketplace-supplied. Same convention `players.ts` set.
   */
  test("an over-length name is refused without echoing it", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const call = t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ players: [tooLong] })],
      });
    await expect(call).rejects.toThrow(/121 characters; the limit is 120/);
    await expect(call).rejects.not.toThrow(new RegExp(tooLong));
  });

  test("an over-length TEAM name is refused too", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await expect(
      t.withIdentity(ADMIN).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ teams: [tooLong] })],
      }),
    ).rejects.toThrow(/team name of 121 characters/);
  });
});

/**
 * NEO-251 (security review) — the OTHER boundary the conflict crosses.
 *
 * A candidate row is written once and then read back into an operator's browser
 * on every tick of a reactive subscription, so an adapter regression that
 * turned one subject string into hundreds of "names" would be paid for on every
 * one of those reads, on every row of a ~900-card batch — long before anything
 * reached a commit. Refused, never trimmed: a truncated roster is a wrong
 * roster that looks right.
 */
describe("startCandidateBatch bounds the roster conflict (NEO-251)", () => {
  const batch = (
    t: ReturnType<typeof convexTest>,
    leafId: Id<"selectorOptions">,
    candidate: {
      players?: string[];
      teams?: string[];
      playersConflict?: { bsc: string[]; sportlots: string[] };
    },
  ) =>
    t.mutation(internal.checklistCandidates.startCandidateBatch, {
      selectorOptionId: leafId,
      batchId: "batch-1",
      userId: ADMIN.subject,
      readyImmediately: true,
      candidates: [
        {
          cardNumber: "1",
          cardName: "Card One",
          platformData: { bsc: { ref: "bsc-1" } },
          ...candidate,
          bucket: "matched" as const,
          confidence: 1,
        },
      ],
    });

  test("more than MAX_CARD_PLAYERS on a side is refused", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await expect(
      batch(t, leafId, {
        playersConflict: { bsc: ["Alec Bohm"], sportlots: tooMany },
      }),
    ).rejects.toThrow(/20-player limit/);
  });

  test("an over-length name is refused without echoing it", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const call = batch(t, leafId, {
      playersConflict: { bsc: [tooLong], sportlots: ["Alec Bohm"] },
    });
    await expect(call).rejects.toThrow(/121 characters; the limit is 120/);
    await expect(call).rejects.not.toThrow(new RegExp(tooLong));
  });

  /**
   * NEO-251 follow-up — the candidate's OWN `players`/`teams`, not only its
   * conflict arrays.
   *
   * They are the same shape from the same source (an adapter parsing a
   * marketplace page), stored in the same row and read back on the same
   * subscription — and they are the larger and far more common field. Bounding
   * only the conflict left the ordinary case open.
   */
  test("the candidate's own players are bounded", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await expect(
      batch(t, leafId, { players: tooMany }),
    ).rejects.toThrow(/20-player limit/);
  });

  test("the candidate's own teams are bounded", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await expect(
      batch(t, leafId, {
        teams: Array.from({ length: 21 }, (_, i) => `Team ${i}`),
      }),
    ).rejects.toThrow(/-team limit/);
  });

  test("an over-length player name on the candidate is refused without echoing it", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const call = batch(t, leafId, { players: [tooLong] });
    await expect(call).rejects.toThrow(
      /player name of 121 characters; the limit is 120/,
    );
    await expect(call).rejects.not.toThrow(new RegExp(tooLong));
  });

  test("an over-length team name on the candidate is refused", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await expect(batch(t, leafId, { teams: [tooLong] })).rejects.toThrow(
      /team name of 121 characters; the limit is 120/,
    );
  });

  test("a legitimate conflict writes, and comes back on the streamed view", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await batch(t, leafId, {
      playersConflict: {
        bsc: ["Mike Yastrzemski"],
        sportlots: ["Mike Yastrzemski", "Carl Yastrzemski"],
      },
    });

    const live = await t
      .withIdentity(ADMIN)
      .query(api.checklistCandidates.getReadyCandidates, {
        selectorOptionId: leafId,
      });
    expect(live.cards[0].playersConflict).toEqual({
      bsc: ["Mike Yastrzemski"],
      sportlots: ["Mike Yastrzemski", "Carl Yastrzemski"],
    });
  });
});

describe("the commit refuses an unsettled roster conflict (NEO-251)", () => {
  /**
   * A card on its way to being WRITTEN has one roster, not an open question.
   * `CardPairingModal` lifts the conflict onto the pair and strips it before
   * `onConfirm`; this is the server-side proof of that rather than a trust in
   * it. Refused rather than ignored, because ignoring it would commit BSC's
   * roster over a disagreement nobody settled — silently, which is the defect.
   */
  test("a card still carrying playersConflict is rejected", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await expect(
      t.withIdentity(ADMIN).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({
            players: ["Mike Yastrzemski"],
            playersConflict: {
              bsc: ["Mike Yastrzemski"],
              sportlots: ["Carl Yastrzemski"],
            },
          }),
        ],
      }),
    ).rejects.toThrow(/unsettled players conflict/);
  });

  test("the same card without the field commits normally", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ players: ["Mike Yastrzemski"] })],
      });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", leafId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cardNumber).toBe("1");
  });
});

/**
 * NEO-253 — the player dedup key folds diacritics.
 *
 * This block was written for NEO-251 as a TRIPWIRE on the opposite behaviour:
 * `nameKey` (lib/cards/card-name.ts) folded NFD, `normalizePlayerName` did not,
 * and the note here said the test "fails the day someone fixes it, which is the
 * point". This is that day, so the assertions are inverted rather than deleted —
 * the pair of them is still the only place the two normalisers are compared to
 * each other, and that comparison is what went unchecked for long enough to
 * produce the defect.
 *
 * The consequence, now that SportLots supplies player names: a card whose roster
 * comes back accented resolves to the existing unaccented player row. Jason,
 * 2026-09-04: "if a card says Jose but the player in the database is José we
 * should just link that player, not consider them new."
 *
 * NO BACKFILL ships with the change. The rows that carry a pre-NEO-253
 * `nameNormalized` are dev and preview rows that are reseeded from the UI on
 * every run, and production has no players yet — see the note on
 * `lib/entities/normalize-name.ts` for what that costs and when it stops being
 * true.
 */
describe("the player dedup key folds diacritics (NEO-253)", () => {
  test("normalizePlayerName folds the accents nameKey has always folded", () => {
    expect(nameKey("José Ramírez")).toBe(nameKey("Jose Ramirez"));
    expect(normalizePlayerName("José Ramírez")).toBe(
      normalizePlayerName("Jose Ramirez"),
    );
    // Not merely "equal to each other" — equal to the plain ASCII key, which is
    // what makes the accented spelling reach the SAME index entry rather than a
    // third one both spellings agree on.
    expect(normalizePlayerName("José Ramírez")).toBe("jose ramirez");
  });

  /**
   * The old chain did not simply drop the accents, it SHREDDED the name:
   * `[^a-z0-9\s-]` turned "é" into a space, so the key was "e jos" rather than
   * anything resembling "jose". Pinned because it is the reason a near-match
   * prompt never fired either — the wizard had no token in common to offer.
   */
  test("an accented name no longer shreds into fragments", () => {
    expect(normalizePlayerName("José Ramírez")).not.toContain(" jos ");
    expect(normalizePlayerName("José Ramírez").split(" ")).toEqual([
      "jose",
      "ramirez",
    ]);
  });

  test("a name with no canonical decomposition is left alone, as before", () => {
    // "ø" has no combining-mark decomposition, so it still falls out of the key
    // exactly as it did before NEO-253. Folding it needs a transliteration
    // table, and a wrong entry in one MERGES two people. See the module note.
    expect(normalizePlayerName("Bjørn Nielsen")).toBe(
      normalizePlayerName("Bj rn Nielsen"),
    );
  });

  test("so an accented roster LINKS to the existing player row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Jose Ramirez",
        nameNormalized: normalizePlayerName("Jose Ramirez"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ players: ["José Ramírez"] })],
      });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", leafId),
        )
        .collect(),
    );
    // Linked to the row NB already had, and NOT carried as a pending name — the
    // observable consequence the NEO-251 note predicted, now in the other
    // direction.
    expect(rows[0].playerIds ?? []).toEqual([playerId]);
    expect(rows[0].pendingPlayerNames ?? []).toEqual([]);

    // And no second person was created for the accented spelling.
    const players = await t.run(async (ctx) =>
      ctx.db.query("players").collect(),
    );
    expect(players).toHaveLength(1);
  });

  test("the reverse direction too: an ASCII roster finds the accented row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "José Ramírez",
        nameNormalized: normalizePlayerName("José Ramírez"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ players: ["Jose Ramirez"] })],
      });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", leafId),
        )
        .collect(),
    );
    expect(rows[0].playerIds ?? []).toEqual([playerId]);
    const players = await t.run(async (ctx) =>
      ctx.db.query("players").collect(),
    );
    expect(players).toHaveLength(1);
    // The row keeps ITS OWN spelling. The fold decides identity; it never
    // rewrites the name NB stores and renders.
    expect(players[0].name).toBe("José Ramírez");
  });
});
