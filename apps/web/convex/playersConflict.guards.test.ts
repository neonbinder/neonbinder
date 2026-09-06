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
 *  3. `normalizePlayerName` does NOT fold diacritics, so SportLots' "José
 *     Ramírez" does not resolve to BSC's existing "Jose Ramirez". Documented
 *     rather than fixed — see the test's own note for why.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { nameKey } from "../lib/cards/card-name";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";

beforeEach(() => {
  // NEO-188/NEO-247: a commit that LANDS schedules a BSC per-card team lookup
  // (processBscTeamEnrichmentQueue) as a side effect of the `bsc-1` ref every
  // fixture card carries. This file has nothing to say about team resolution.
  // A THROWING stub rather than a canned 200 — same convention as
  // convex/cardChecklist.bscTeamEnrichment.test.ts's NEO-220 fix: the adapter
  // already swallows a request failure ("network unavailable" is a state it
  // handles), and it cannot write anything derived from a payload this file
  // invented.
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(
        `NEO-247: this test file must not reach the network: ${String(url)}`,
      );
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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
    // NEO-247: settle (and discard) the enrichment this commit scheduled before
    // the test returns, so nothing is still running into worker teardown.
    await drainScheduled(t);
    await cancelScheduled(t);
  });
});

/**
 * NEO-251 (security review, item 7) — DOCUMENTS A KNOWN GAP.
 *
 * `nameKey` (lib/cards/card-name.ts) folds NFD before stripping, so it treats
 * "José Ramírez" and "Jose Ramirez" as one name — that is what stops the
 * pairing modal flagging every accent difference between the two marketplaces.
 * `normalizePlayerName`, the `players.nameNormalized` DEDUP KEY, does not: it
 * lowercases and then drops every character outside `[a-z0-9\s-]`, so the
 * accented spelling shreds into different tokens entirely.
 *
 * The consequence, now that SportLots supplies player names: a card whose
 * roster comes back accented does not resolve to the existing unaccented
 * player row, and the name goes to the entity wizard as unknown — where an
 * operator can create a SECOND row for the same person.
 *
 * WHY THIS IS NOT FIXED IN THIS BRANCH. The function is the stored dedup key,
 * indexed as `by_name_normalized_and_sport_id`. Changing it without rewriting
 * every stored `nameNormalized` makes existing accented rows unreachable by the
 * new key — which mints the very duplicate the change is meant to prevent. A
 * correct fix is therefore a migration, and it spans `players`, `teams`
 * (`normalizeTeamName`), the prelude's own inline `norm`, `entityReviewSkips`
 * and `entityReviewQueue`, all of which key on the same shape. It can merge or
 * split PLAYER IDENTITY rows, which is exactly the class of change the product
 * invariant says must be operator-reviewed rather than ridden along on a UI
 * ticket. It wants its own ticket, its own backfill and its own review.
 *
 * This test fails the day someone fixes it, which is the point: it is a
 * tripwire on a documented behaviour, not an endorsement of it.
 */
describe("diacritics do not fold in the player dedup key (NEO-251, deferred)", () => {
  test("nameKey folds the accents that normalizePlayerName does not", () => {
    expect(nameKey("José Ramírez")).toBe(nameKey("Jose Ramirez"));
    expect(normalizePlayerName("José Ramírez")).not.toBe(
      normalizePlayerName("Jose Ramirez"),
    );
  });

  test("so an accented roster does not link to the existing player row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("players", {
        name: "Jose Ramirez",
        nameNormalized: normalizePlayerName("Jose Ramirez"),
        sportId,
        lastUpdated: Date.now(),
      });
    });

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
    // Unlinked, and carried as a pending NAME instead — the card is not wrong,
    // but the person on it is not the person NB already knows about.
    expect(rows[0].playerIds ?? []).toEqual([]);
    expect(rows[0].pendingPlayerNames).toEqual(["José Ramírez"]);
    // NEO-247: settle (and discard) the enrichment this commit scheduled before
    // the test returns, so nothing is still running into worker teardown.
    await drainScheduled(t);
    await cancelScheduled(t);
  });
});
