/**
 * NEO-254 — the card's own year, used to tell two same-name players apart.
 *
 * ## What this covers and why it is its own file
 *
 * `convex/playersAmbiguity.test.ts` pins the RULE that two rows sharing a
 * normalized name never auto-link. That rule is correct and, on its own,
 * expensive: a 1990 set with eight hundred commons would hand the operator a
 * decision for every name two people have ever shared, almost all of which
 * have exactly one plausible answer because the other man retired in 1937.
 *
 * This file pins the narrowing that spends the card's own evidence before
 * spending the operator's attention — and, just as importantly, every case
 * where it declines to. Every test here is one branch of
 * `players.narrowSameNamePlayersByCardYear`, exercised through the two entry
 * points that use it: the review gate (`players.resolveNameForReview`) and the
 * commit prelude (`selectorOptions.commitCardChecklistPrelude`).
 *
 * The pure arithmetic underneath — what a span is, where the ±2 window ends —
 * is asserted in `lib/players/career-span.test.ts`.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  CAREER_TEAM_READS_PER_NAME,
  CARD_YEAR_TEAM_READS_PER_TRANSACTION,
  createCardYearTeamCache,
  narrowSameNamePlayersByCardYear,
} from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_card_year_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_card_year_001",
  name: "Admin User",
  role: "admin",
};

/**
 * sport → year → setName → variantType, so the year the narrowing reads is a
 * real `year`-level ancestor rather than a `features.season` shortcut.
 *
 * `season` is deliberately LEFT OFF every node here: it wins over the ancestor
 * when present, and a fixture that set both would never prove the ancestor
 * walk runs at all.
 */
async function seedSetOfYear(
  t: ReturnType<typeof convexTest>,
  year: string | null,
) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    // `year === null` is the set with NO year anywhere in its chain — an
    // orphaned subtree, or a fixture built before the year row existed. It is
    // the case the narrowing must refuse to act on.
    const yearId =
      year === null
        ? undefined
        : await ctx.db.insert("selectorOptions", {
            level: "year",
            value: year,
            platformData: {},
            parentId: sportId,
            children: [],
            lastUpdated: Date.now(),
          });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: {},
      ...(yearId ? { parentId: yearId } : { parentId: sportId }),
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    if (yearId) await ctx.db.patch(yearId, { children: [setNameId] });
    await ctx.db.patch(sportId, { children: [yearId ?? setNameId] });
    return { sportId, variantTypeId };
  });
}

async function insertTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  location: string,
  name: string,
  nameNormalized: string,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      location,
      name,
      nameNormalized,
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function insertBobAllen(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  teamYears?: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      sportId,
      ...(teamYears ? { teamYears } : {}),
      lastUpdated: Date.now(),
    }),
  );
}

function resolve(
  t: ReturnType<typeof convexTest>,
  args: {
    sportId: Id<"selectorOptions">;
    cardYear?: number;
    cardTeamNames?: string[];
    /** Defaults to the file's stock ambiguous name. */
    name?: string;
  },
) {
  return t.query(internal.players.resolveNameForReview, {
    name: args.name ?? "Bob Allen",
    sportId: args.sportId,
    ...(args.cardYear !== undefined ? { cardYear: args.cardYear } : {}),
    ...(args.cardTeamNames ? { cardTeamNames: args.cardTeamNames } : {}),
  });
}

// ===========================================================================
// The review gate
// ===========================================================================

describe("NEO-254: the card's year narrows same-name players at the review gate", () => {
  test("one match links, with or without a year", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const only = await insertBobAllen(t, sportId);

    const withYear = await resolve(t, { sportId, cardYear: 1990 });
    expect(withYear).toEqual({ matchCount: 1, playerId: only });
    // No `narrowedByCardYear`: one row was never a choice, so nothing was
    // narrowed and the flag must not claim otherwise.
    const withoutYear = await resolve(t, { sportId });
    expect(withoutYear).toEqual({ matchCount: 1, playerId: only });
  });

  test("two rows, only one active in the card's year → that one links", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const modern = await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1930, toYear: 1937 },
    ]);

    const resolved = await resolve(t, { sportId, cardYear: 1990 });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBe(modern);
    // Flagged, so an automatic link made on the strength of a year is
    // distinguishable in the logs from one made because the name was unique.
    expect(resolved.narrowedByCardYear).toBe(true);
  });

  test("two rows both active in the card's year → review, not a coin toss", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertBobAllen(t, sportId, [{ teamId: padres, fromYear: 1986, toYear: 1994 }]);
    await insertBobAllen(t, sportId, [{ teamId: padres, fromYear: 1988, toYear: 1991 }]);

    const resolved = await resolve(t, { sportId, cardYear: 1990 });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBeUndefined();
  });

  test("the team printed on the card breaks a tie the year cannot", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const cub = await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1988, toYear: 1991 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);

    // Both are contemporaries, so the year alone still says "ask a human"…
    expect((await resolve(t, { sportId, cardYear: 1990 })).playerId).toBeUndefined();
    // …and the team on the card settles it.
    const byTeam = await resolve(t, {
      sportId,
      cardYear: 1990,
      cardTeamNames: ["Chicago Cubs"],
    });
    expect(byTeam.playerId).toBe(cub);
    expect(byTeam.narrowedByCardYear).toBe(true);
  });

  test("the bare nickname on the card matches a row that carries a location", async () => {
    // The normaliser TOKEN-SORTS, so "Cubs" and "Chicago Cubs" are two
    // different keys. A checklist writes either one depending on the source
    // column, and the tie-break has to answer to both.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const cub = await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1988, toYear: 1991 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);

    expect(
      (await resolve(t, { sportId, cardYear: 1990, cardTeamNames: ["Cubs"] }))
        .playerId,
    ).toBe(cub);
  });

  test("a team the card names that BOTH were on in that year does not break the tie", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    await insertBobAllen(t, sportId, [{ teamId: cubs, fromYear: 1988, toYear: 1991 }]);
    await insertBobAllen(t, sportId, [{ teamId: cubs, fromYear: 1989, toYear: 1990 }]);

    expect(
      (await resolve(t, { sportId, cardYear: 1990, cardTeamNames: ["Chicago Cubs"] }))
        .playerId,
    ).toBeUndefined();
  });

  test("the team tie-break reads the stint that covers the YEAR, not any stint", async () => {
    // The other man was a Cub, but in 1975. A card of 1990 naming the Cubs is
    // not about him, and a tie-break that ignored the year would say it was.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const current = await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1989, toYear: 1992 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1975, toYear: 1977 },
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);

    expect(
      (await resolve(t, { sportId, cardYear: 1990, cardTeamNames: ["Chicago Cubs"] }))
        .playerId,
    ).toBe(current);
  });

  test("an unknown career span is never excluded — it forces the review", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertBobAllen(t, sportId, [{ teamId: padres, fromYear: 1986, toYear: 1994 }]);
    // No stints at all: a bare row created from a card and never enriched.
    // Excluding him would hand the 1990 card to the other man on the strength
    // of a gap in OUR data.
    await insertBobAllen(t, sportId);

    const resolved = await resolve(t, { sportId, cardYear: 1990 });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBeUndefined();
  });

  test("no card year → review, never a guess", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertBobAllen(t, sportId, [{ teamId: padres, fromYear: 1986, toYear: 1994 }]);
    await insertBobAllen(t, sportId, [{ teamId: padres, fromYear: 1930, toYear: 1937 }]);

    // The 1937 man is obviously wrong, and the answer is STILL "ask": with no
    // year there is no evidence, and picking the plausible one is a guess.
    const resolved = await resolve(t, { sportId });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBeUndefined();
  });
});

// ===========================================================================
// The set year comes from the ancestry, and an absent one narrows nothing
// ===========================================================================

describe("NEO-254: the set year is walked from the selectorOption ancestry", () => {
  test("a set with no year row anywhere narrows nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetOfYear(t, null);
    expect(
      await t.query(internal.selectorOptions.findSetYearForSelectorOptionQuery, {
        selectorOptionId: variantTypeId,
      }),
    ).toBeNull();
    expect(sportId).toBeTruthy();
  });

  test("the year-level ancestor is found from the variant leaf", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedSetOfYear(t, "1990");
    expect(
      await t.query(internal.selectorOptions.findSetYearForSelectorOptionQuery, {
        selectorOptionId: variantTypeId,
      }),
    ).toBe(1990);
  });
});

// ===========================================================================
// The commit prelude — the same rule, on the write path
// ===========================================================================

function makeCard(overrides: {
  cardNumber?: string;
  players?: string[];
  teams?: string[];
}) {
  return {
    cardNumber: overrides.cardNumber ?? "1",
    cardName: "Card",
    team: undefined,
    teams: overrides.teams ?? [],
    players: overrides.players ?? [],
    attributes: [],
    isRookie: false,
    isRelic: false,
    printRun: undefined,
    autographType: undefined,
    cardVariation: undefined,
    platformData: {},
    unmatched: undefined,
  };
}

async function commit(
  t: ReturnType<typeof convexTest>,
  ids: { sportId: Id<"selectorOptions">; variantTypeId: Id<"selectorOptions"> },
  cards: ReturnType<typeof makeCard>[],
  batchId?: string,
) {
  await t
    .withIdentity(ADMIN_IDENTITY)
    .action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: ids.variantTypeId,
      sportId: ids.sportId,
      cards,
      ...(batchId ? { batchId } : {}),
    });
  return t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", ids.variantTypeId),
      )
      .collect(),
  );
}

describe("NEO-254: the commit prelude narrows on the card's year too", () => {
  test("the only candidate active in the set's year gets the card", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, ids.sportId, "San Diego", "Padres", "diego padres san");
    const modern = await insertBobAllen(t, ids.sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);
    await insertBobAllen(t, ids.sportId, [
      { teamId: padres, fromYear: 1930, toYear: 1937 },
    ]);

    const cards = await commit(t, ids, [makeCard({ players: ["Bob Allen"] })]);
    expect(cards).toHaveLength(1);
    expect(cards[0].playerIds).toEqual([modern]);
    // And no third Bob Allen was minted on the way.
    const allPlayers = await t.run(async (ctx) => ctx.db.query("players").collect());
    expect(allPlayers).toHaveLength(2);
  });

  test("two contemporaries leave the card unlinked, awaiting the wizard", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, ids.sportId, "San Diego", "Padres", "diego padres san");
    await insertBobAllen(t, ids.sportId, [{ teamId: padres, fromYear: 1986, toYear: 1994 }]);
    await insertBobAllen(t, ids.sportId, [{ teamId: padres, fromYear: 1988, toYear: 1991 }]);

    const cards = await commit(t, ids, [makeCard({ players: ["Bob Allen"] })]);
    expect(cards[0].playerIds ?? []).toEqual([]);
    // The name survives as free text, so nothing about the card is lost and
    // the attention walker can still surface it.
    expect(cards[0].pendingPlayerNames).toContain("Bob Allen");
    expect(await t.run(async (ctx) => ctx.db.query("players").collect())).toHaveLength(2);
  });

  test("the team printed on the card breaks the tie on the write path", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, ids.sportId, "San Diego", "Padres", "diego padres san");
    const cubs = await insertTeam(t, ids.sportId, "Chicago", "Cubs", "chicago cubs");
    const cub = await insertBobAllen(t, ids.sportId, [
      { teamId: cubs, fromYear: 1988, toYear: 1991 },
    ]);
    await insertBobAllen(t, ids.sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);

    const cards = await commit(t, ids, [
      makeCard({ players: ["Bob Allen"], teams: ["Chicago Cubs"] }),
    ]);
    expect(cards[0].playerIds).toEqual([cub]);
  });

  test("an operator's recorded decision beats the narrowing", async () => {
    /*
     * The ordering this pins.
     *
     * A review session is human-paced and the commit happens at the end of it.
     * Between the operator picking the 1930s man (they had a reason — a
     * missing stint, a source they checked) and pressing Confirm, a bulk load
     * can add stints that make the year evidence point at the other row. If
     * the narrowing ran first it would silently overrule a person who had
     * already looked at these very rows. Inference fills a silence; it never
     * overrules an answer.
     */
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, ids.sportId, "San Diego", "Padres", "diego padres san");
    // The one the year evidence would pick on its own.
    await insertBobAllen(t, ids.sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);
    const operatorsPick = await insertBobAllen(t, ids.sportId, [
      { teamId: padres, fromYear: 1930, toYear: 1937 },
    ]);

    await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: ids.variantTypeId,
        batchId: "batch-1",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player" as const,
        name: "Bob Allen",
        sportId: ids.sportId,
        status: "ready" as const,
        decision: { action: "link" as const, linkedPlayerId: operatorsPick },
      }),
    );

    const cards = await commit(
      t,
      ids,
      [makeCard({ players: ["Bob Allen"] })],
      "batch-1",
    );
    expect(cards[0].playerIds).toEqual([operatorsPick]);
  });

  test("a SKIP is an answer too, and the narrowing does not undo it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, ids.sportId, "San Diego", "Padres", "diego padres san");
    await insertBobAllen(t, ids.sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);
    await insertBobAllen(t, ids.sportId, [
      { teamId: padres, fromYear: 1930, toYear: 1937 },
    ]);

    await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: ids.variantTypeId,
        batchId: "batch-1",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player" as const,
        name: "Bob Allen",
        sportId: ids.sportId,
        status: "ready" as const,
        decision: { action: "skip" as const },
      }),
    );

    const cards = await commit(
      t,
      ids,
      [makeCard({ players: ["Bob Allen"] })],
      "batch-1",
    );
    expect(cards[0].playerIds ?? []).toEqual([]);
  });

  test("two spellings of one name pool the teams their cards carry", async () => {
    /*
     * NEO-254 — `cardTeamNamesByPlayer` is keyed by the NORMALIZED name.
     *
     * "J.T. Realmuto" and "JT Realmuto" are one row in `players`, and a
     * checklist routinely spells a player both ways across a base card and a
     * subset. Keyed by the raw string, the tie-break would see only the teams
     * from whichever spelling it happened to look up — here, the Cubs card
     * would be invisible to the "JT Realmuto" lookup and the tie would stand
     * unbroken.
     */
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, ids.sportId, "San Diego", "Padres", "diego padres san");
    const cubs = await insertTeam(t, ids.sportId, "Chicago", "Cubs", "chicago cubs");
    const cub = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "J.T. Realmuto",
        nameNormalized: "jt realmuto",
        sportId: ids.sportId,
        teamYears: [{ teamId: cubs, fromYear: 1988, toYear: 1991 }],
        lastUpdated: Date.now(),
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "JT Realmuto",
        nameNormalized: "jt realmuto",
        sportId: ids.sportId,
        teamYears: [{ teamId: padres, fromYear: 1986, toYear: 1994 }],
        lastUpdated: Date.now(),
      }),
    );

    const cards = await commit(t, ids, [
      // The team rides on the DOTTED spelling…
      makeCard({
        cardNumber: "1",
        players: ["J.T. Realmuto"],
        teams: ["Chicago Cubs"],
      }),
      // …and this card, spelled the other way, carries no team at all.
      makeCard({ cardNumber: "2", players: ["JT Realmuto"] }),
    ]);
    const byNumber = new Map(cards.map((c) => [c.cardNumber, c]));
    // Both spellings resolve to the same man, on the pooled evidence.
    expect(byNumber.get("1")!.playerIds).toEqual([cub]);
    expect(byNumber.get("2")!.playerIds).toEqual([cub]);
  });

  test("a set with no year leaves both candidates standing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, null);
    const padres = await insertTeam(t, ids.sportId, "San Diego", "Padres", "diego padres san");
    await insertBobAllen(t, ids.sportId, [{ teamId: padres, fromYear: 1986, toYear: 1994 }]);
    await insertBobAllen(t, ids.sportId, [{ teamId: padres, fromYear: 1930, toYear: 1937 }]);

    const cards = await commit(t, ids, [makeCard({ players: ["Bob Allen"] })]);
    expect(cards[0].playerIds ?? []).toEqual([]);
  });
});

// ===========================================================================
// The wizard's candidate list says who was active
// ===========================================================================

describe("NEO-254: candidates carry whether they were active in the set's year", () => {
  test("only the candidate whose stints cover the year is flagged", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const modern = await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);
    const older = await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1930, toYear: 1937 },
    ]);
    // A third with no stints, so "unflagged" covers both reasons: not that
    // year, and nothing on file to say.
    const bare = await insertBobAllen(t, sportId);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: variantTypeId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Bob Allen"],
      teamNames: [],
    });
    expect(batchId).toBeTruthy();

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", variantTypeId).eq("batchId", batchId),
        )
        .first(),
    );
    const byId = new Map(
      (row!.enrichment!.existingCandidates ?? []).map((c) => [c.playerId, c]),
    );
    expect(byId.get(modern)!.activeInSetYear).toBe(true);
    // Absent, never `false`: the flag states what we can stand behind.
    expect(byId.get(older)!.activeInSetYear).toBeUndefined();
    expect(byId.get(bare)!.activeInSetYear).toBeUndefined();
  });

  test("getBatch returns the flag — the wizard actually opens", async () => {
    /*
     * The regression this exists for.
     *
     * `enrichmentValidator` in convex/entityReviewQueue.ts is a hand-kept copy
     * of the schema's enrichment shape, and Convex validates a function's
     * RETURN against it. A field written to the row but missing from that copy
     * is not a type error — it is a runtime "Unexpected field" thrown by every
     * query that returns a row, so the whole wizard fails to open for any batch
     * containing a same-name player whose stint covers the set year.
     *
     * The sibling tests above read rows through `t.run`, which goes straight to
     * the database and past every validator, so none of them could catch it.
     * This one goes through the public query the wizard actually calls.
     */
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetOfYear(t, "1990");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const modern = await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1986, toYear: 1994 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1930, toYear: 1937 },
    ]);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: variantTypeId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Bob Allen"],
      teamNames: [],
    });

    const rows = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.entityReviewQueue.getBatch, {
        selectorOptionId: variantTypeId,
        batchId,
      });
    expect(rows).toHaveLength(1);
    const candidates = rows[0].enrichment!.existingCandidates ?? [];
    expect(candidates).toHaveLength(2);
    expect(
      candidates.find((c) => c.playerId === modern)!.activeInSetYear,
    ).toBe(true);
  });

  test("with no set year, nothing is flagged and nothing is dropped", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetOfYear(t, null);
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertBobAllen(t, sportId, [{ teamId: padres, fromYear: 1986, toYear: 1994 }]);
    await insertBobAllen(t, sportId, [{ teamId: padres, fromYear: 1930, toYear: 1937 }]);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: variantTypeId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Bob Allen"],
      teamNames: [],
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", variantTypeId).eq("batchId", batchId),
        )
        .first(),
    );
    const candidates = row!.enrichment!.existingCandidates ?? [];
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.activeInSetYear === undefined)).toBe(true);
  });
});

// ===========================================================================
// NEO-254 — the career-start rule, on the case it was written for
//
// Jason, 2026-09-08, verbatim: "not to consider any players that started their
// career after the card was made." Both Griffeys answer to "Ken Griffey" —
// that is the point of allowing a shared alias — and the card's year is what
// decides which man a given card means.
// ===========================================================================

describe("NEO-254: two Griffeys, one alias, and the card's year", () => {
  /** Sr 1973–1991, Jr 1989–2010 with "Ken Griffey" as an alias. */
  async function seedGriffeys(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
  ) {
    const reds = await insertTeam(t, sportId, "Cincinnati", "Reds", "cincinnati reds");
    const mariners = await insertTeam(t, sportId, "Seattle", "Mariners", "mariners seattle");
    const father = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Ken Griffey",
        nameNormalized: "griffey ken",
        sportId,
        teamYears: [{ teamId: reds, fromYear: 1973, toYear: 1991 }],
        lastUpdated: Date.now(),
      }),
    );
    const son = await t.run(async (ctx) => {
      const id = await ctx.db.insert("players", {
        name: "Ken Griffey Jr",
        nameNormalized: "griffey jr ken",
        sportId,
        aliases: ["Ken Griffey"],
        teamYears: [{ teamId: mariners, fromYear: 1989, toYear: 2010 }],
        lastUpdated: Date.now(),
      });
      await ctx.db.insert("playerAliases", {
        playerId: id,
        sportId,
        aliasNormalized: "griffey ken",
      });
      return id;
    });
    return { father, son, mariners };
  }

  test("a 1985 card is the FATHER — the son had not started", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1985");
    const { father } = await seedGriffeys(t, sportId);

    const resolved = await resolve(t, {
      sportId,
      cardYear: 1985,
      name: "Ken Griffey",
    });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBe(father);
    expect(resolved.narrowedByCardYear).toBe(true);
  });

  test("a 1989 card WITH the Mariners on it is the son", async () => {
    // Both were playing in 1989, so the year alone cannot decide — the team
    // printed on the card is what separates them.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1989");
    const { son } = await seedGriffeys(t, sportId);

    const resolved = await resolve(t, {
      sportId,
      cardYear: 1989,
      cardTeamNames: ["Seattle Mariners"],
      name: "Ken Griffey",
    });
    expect(resolved.playerId).toBe(son);
  });

  test("a 1989 card with NO team goes to review, with the son flagged active", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedSetOfYear(t, "1989");
    const { father, son } = await seedGriffeys(t, sportId);

    // Neither wins: both were on a roster that year.
    expect(
      (await resolve(t, { sportId, cardYear: 1989, name: "Ken Griffey" }))
        .playerId,
    ).toBeUndefined();

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: variantTypeId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Ken Griffey"],
      teamNames: [],
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", variantTypeId).eq("batchId", batchId),
        )
        .first(),
    );
    const byId = new Map(
      (row!.enrichment!.existingCandidates ?? []).map((c) => [c.playerId, c]),
    );
    expect(byId.size).toBe(2);
    expect(byId.get(son)!.activeInSetYear).toBe(true);
    expect(byId.get(father)!.activeInSetYear).toBe(true);
    // And the son says WHY he is on a list for a name that is not his.
    expect(byId.get(son)!.matchedAlias).toBe("Ken Griffey");
  });
});

describe("NEO-254: a prospect card printed before the debut", () => {
  async function seedProspect(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    debutYear: number,
    /** Absent = still playing. A retired rival is what makes the year decide. */
    lastYear?: number,
  ) {
    const team = await insertTeam(t, sportId, "Seattle", "Mariners", "mariners seattle");
    return t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Julio Rodriguez",
        nameNormalized: "julio rodriguez",
        sportId,
        teamYears: [
          {
            teamId: team,
            fromYear: debutYear,
            ...(lastYear !== undefined ? { toYear: lastYear } : {}),
          },
        ],
        lastUpdated: Date.now(),
      }),
    );
  }

  test("2019 card, 2021 debut — inside the tolerance, so it links", async () => {
    // The set year routinely precedes the first recorded game by a season, and
    // a source's "first year" is its own opinion. ±2 covers an ordinary rookie
    // card without re-admitting Griffey Jr. to a 1985 card.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2019");
    const player = await seedProspect(t, sportId, 2021);
    // A retired man of the same name — long out of the game by 2019, so the
    // year rules him out and leaves the prospect alone.
    await seedProspect(t, sportId, 1975, 1984);

    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Julio Rodriguez",
      sportId,
      cardYear: 2019,
    });
    expect(resolved.matchCount).toBe(2);
    expect(resolved.playerId).toBe(player);
  });

  test("2018 card, 2021 debut — past the tolerance, so it goes to review", async () => {
    /*
     * The Bowman caveat, stated as a test. A deep prospect card starts after
     * the card by more than the window allows, so the candidate is excluded
     * and the name routes to a human.
     *
     * That is the intended trade: widening the window to cover it would
     * re-admit Griffey Jr. to a 1985 card, which is exactly the case the rule
     * exists to exclude. Sending a genuine prospect card to review costs one
     * decision and loses nothing.
     */
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2018");
    await seedProspect(t, sportId, 2021);

    const resolved = await t.query(internal.players.resolveNameForReview, {
      name: "Julio Rodriguez",
      sportId,
      cardYear: 2018,
    });
    expect(resolved.matchCount).toBe(1);
    // One row of that name, so it links regardless — the narrowing only ever
    // rules between several. The exclusion is visible with a second candidate.
    expect(resolved.playerId).toBeTruthy();

    const second = await seedProspect(t, sportId, 1975, 2019);
    const withRival = await t.query(internal.players.resolveNameForReview, {
      name: "Julio Rodriguez",
      sportId,
      cardYear: 2018,
    });
    expect(withRival.matchCount).toBe(2);
    // The 2021 debut is out; the 1975 man is the only survivor.
    expect(withRival.playerId).toBe(second);
  });
});

// ===========================================================================
// NEO-296 — the team tie-break's budget is PER NAME, and the answer no longer
// depends on where the name sits
//
// It used to be a commit-wide budget of 64 documents, held in the shared
// cache's `spent`. Two things followed, and the second is what forced the
// change: the same ambiguous name resolved differently at position 700 than at
// position 5 (the budget was simply gone by then), and once the prelude's
// resolution walk is split across transactions, "where the budget resets"
// becomes a function of the page size — so paging would have moved an ANSWER,
// not just a cost.
//
// Jason, 2026-09-22, chose the per-name bound knowing it links MORE names
// automatically than the commit-wide one did: names that used to fall past a
// spent budget now get their tie-break. The property bought is the one these
// tests pin — the same name resolves the same way wherever it sits.
//
// The budget is charged on CONSULTATION, not on the read, so a team another
// name already warmed in the shared memo still costs this name a unit. That is
// what keeps the memo a pure cost saving with no say in the answer.
// ===========================================================================

describe("NEO-296: the card-team tie-break is bounded per NAME", () => {
  /**
   * `count` distinct teams, all named on the card, all covering 1994 — so the
   * tie-break must consult every one of them before it can conclude anything.
   */
  async function seedManyTeamStints(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    count: number,
  ) {
    const teamIds: Id<"teams">[] = [];
    for (let i = 0; i < count; i++) {
      teamIds.push(
        await insertTeam(t, sportId, `City${i}`, `Club${i}`, `city${i} club${i}`),
      );
    }
    return teamIds;
  }

  test("a name consulting more teams than the budget allows falls to a human, never to a guess", async () => {
    // The guard the budget exists for: a corrupt or hand-edited `teamYears`
    // with more overlapping open stints than any real player has. A partial
    // read must not pick a winner, so the tie-break is abandoned and the year
    // filter's answer stands — which here is "two survivors, ask someone".
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1994");
    const teamIds = await seedManyTeamStints(t, sportId, 12);
    const other = await insertTeam(t, sportId, "Elsewhere", "Nine", "elsewhere nine");
    /*
     * The fixture is built so the tie-break WOULD succeed if the budget
     * allowed it, which is the only way this test can tell a real bound from a
     * fixture that was never going to resolve anyway.
     *
     * This Bob Allen holds twelve concurrent stints and the card names his
     * TWELFTH team, so the answer is only reachable past the eighth
     * consultation. The other Bob Allen is on a team the card does not name,
     * and is active in 1994 — so the year filter leaves two survivors and the
     * teams are the only thing that could separate them.
     */
    await insertBobAllen(
      t,
      sportId,
      teamIds.map((teamId) => ({ teamId, fromYear: 1990, toYear: 1999 })),
    );
    await insertBobAllen(t, sportId, [
      { teamId: other, fromYear: 1993, toYear: 1995 },
    ]);

    const resolved = await resolve(t, {
      sportId,
      cardYear: 1994,
      cardTeamNames: ["City11 Club11"],
    });

    // Abandoned, not guessed: no winner, and specifically not the first row
    // the index happened to return.
    expect(resolved.playerId).toBeUndefined();
    expect(resolved.matchCount).toBe(2);
  });

  test("a name inside the budget takes the tie-break and REPORTS that it did", async () => {
    // `narrowedByCardYear` is the marker on the one link an operator never
    // sees. The budget change makes this fire more often, not less, so the
    // reporting matters more than it did — it is what answers "which cards did
    // this happen to" on the day the inference is wrong.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1994");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const onPadres = await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1990, toYear: 1999 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1990, toYear: 1999 },
    ]);

    const resolved = await resolve(t, {
      sportId,
      cardYear: 1994,
      cardTeamNames: ["San Diego Padres"],
    });

    expect(resolved.playerId).toBe(onPadres);
    expect(resolved.narrowedByCardYear).toBe(true);
    // Two rows really did answer to the name — this was a tie-break, not a
    // lookup that happened to find one row.
    expect(resolved.matchCount).toBe(2);
  });

  test("the SAME name resolves the same way however many names were narrowed before it", async () => {
    /*
     * THE PROPERTY JASON BOUGHT. Under the old commit-wide budget this is
     * exactly what broke: enough earlier narrowing spent the 64, and this
     * name — unchanged, on an unchanged card — stopped getting its tie-break
     * and went to the operator instead.
     *
     * Driven through `resolveNameForReview`, which builds a fresh cache per
     * call, and then through a long run of OTHER ambiguous names in one
     * process, so any shared counter would have been drained by the time the
     * subject is asked again.
     */
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1994");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const onPadres = await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1990, toYear: 1999 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1990, toYear: 1999 },
    ]);

    const first = await resolve(t, {
      sportId,
      cardYear: 1994,
      cardTeamNames: ["San Diego Padres"],
    });

    // Plenty of other ambiguous names, each consulting teams of its own.
    const noise = await seedManyTeamStints(t, sportId, 40);
    for (let i = 0; i < 40; i++) {
      await t.run(async (ctx) => {
        for (const suffix of ["a", "b"]) {
          await ctx.db.insert("players", {
            name: `Noise${i}${suffix}`,
            nameNormalized: `noise${i}`,
            sportId,
            teamYears: [{ teamId: noise[i], fromYear: 1990, toYear: 1999 }],
            lastUpdated: Date.now(),
          });
        }
      });
      await resolve(t, {
        sportId,
        name: `Noise${i}a`,
        cardYear: 1994,
        cardTeamNames: [`City${i} Club${i}`],
      });
    }

    const later = await resolve(t, {
      sportId,
      cardYear: 1994,
      cardTeamNames: ["San Diego Padres"],
    });

    expect(later.playerId).toBe(onPadres);
    expect(later.playerId).toBe(first.playerId);
    expect(later.narrowedByCardYear).toBe(first.narrowedByCardYear);
  });
});

// ===========================================================================
// NEO-296 (audit condition 2) — the per-name budget is JOINED by a
// transaction total, and reaching it ENDS THE PAGE
//
// The per-name bound above is what makes an answer position-independent, and
// it stands. On its own, though, it bounds nothing at the transaction: 8 reads
// times `PRELUDE_NAMES_PER_PAGE` (300) is 2,400, past the ~1,800 the house
// calibration calls straining. So a transaction total came back —
// `CARD_YEAR_TEAM_READS_PER_TRANSACTION`, counted on actual `db.get`s and held
// on the shared cache.
//
// The whole point is WHAT REACHING IT DOES. Letting the remaining names fall
// to review would put position-dependence straight back: the same name would
// resolve near the top of a page and go to a human near the bottom of one, and
// the boundary would move with the page size. Instead the page ENDS, `hasMore`
// carries the rest, and every deferred name is walked by the next transaction
// from a fresh cache — where it answers exactly as it would have at position
// 0. That is the property these tests pin.
// ===========================================================================

describe("NEO-296: the tie-break's transaction total ends the page, never an answer", () => {
  /** Two rows under one name, separable only by the team on the card. */
  async function seedAmbiguousPair(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    name: string,
    normalized: string,
    wanted: { location: string; club: string },
    other: { location: string; club: string },
  ): Promise<{ winner: Id<"players">; cardTeam: string }> {
    const wantedTeam = await insertTeam(
      t,
      sportId,
      wanted.location,
      wanted.club,
      `${wanted.club} ${wanted.location}`.toLowerCase(),
    );
    const otherTeam = await insertTeam(
      t,
      sportId,
      other.location,
      other.club,
      `${other.club} ${other.location}`.toLowerCase(),
    );
    const winner = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: normalized,
        sportId,
        teamYears: [{ teamId: wantedTeam, fromYear: 1990, toYear: 1999 }],
        lastUpdated: Date.now(),
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: normalized,
        sportId,
        teamYears: [{ teamId: otherTeam, fromYear: 1990, toYear: 1999 }],
        lastUpdated: Date.now(),
      }),
    );
    return { winner, cardTeam: `${wanted.location} ${wanted.club}` };
  }

  /** One resolve page, with the team-read ceiling under the test's control. */
  function resolvePage(
    t: ReturnType<typeof convexTest>,
    variantTypeId: Id<"selectorOptions">,
    sportId: Id<"selectorOptions">,
    playerNames: string[],
    playerTeamNames: Array<{ playerNameNormalized: string; teams: string[] }>,
    extra: Record<string, unknown>,
  ) {
    return t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(internal.selectorOptions.commitCardChecklistPrelude, {
        selectorOptionId: variantTypeId,
        sportId,
        playerNames,
        teamNames: [],
        playerTeamNames,
        phase: "resolve" as const,
        ...extra,
      });
  }

  async function seedTwoAmbiguousNames(t: ReturnType<typeof convexTest>) {
    const { sportId, variantTypeId } = await seedSetOfYear(t, "1994");
    const first = await seedAmbiguousPair(
      t,
      sportId,
      "Bob Allen",
      "allen bob",
      { location: "San Diego", club: "Padres" },
      { location: "Chicago", club: "Cubs" },
    );
    const second = await seedAmbiguousPair(
      t,
      sportId,
      "Cal Baker",
      "baker cal",
      { location: "New York", club: "Yankees" },
      { location: "Boston", club: "Red Sox" },
    );
    return {
      sportId,
      variantTypeId,
      first,
      second,
      names: ["Bob Allen", "Cal Baker"],
      cardTeams: [
        { playerNameNormalized: "allen bob", teams: [first.cardTeam] },
        { playerNameNormalized: "baker cal", teams: [second.cardTeam] },
      ],
    };
  }

  test("a page that spends the transaction's team reads STOPS instead of answering the rest", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedTwoAmbiguousNames(t);

    // A ceiling of one read: the first name spends it, so the second cannot be
    // evaluated on its full allowance and must not be evaluated at all.
    const page = await resolvePage(
      t,
      seed.variantTypeId,
      seed.sportId,
      seed.names,
      seed.cardTeams,
      { resume: { offset: 0 }, cardYearTeamReads: 1 },
    );

    // The first name got its tie-break, on its own full allowance.
    expect(page.playerIdByName).toEqual([
      { name: "Bob Allen", id: seed.first.winner },
    ]);
    // The second was neither answered nor reported as needing a human — it was
    // simply not reached. THIS is the fix: a name that falls to review here
    // would be a different answer from the one it gets at the top of a page.
    expect(page.unreviewedPlayerNames ?? []).not.toContain("Cal Baker");
    expect(page.hasMore).toBe(true);
    // The cursor points AT the deferred name, not past it.
    expect(page.resume).toEqual({ offset: 1 });
  });

  test("the deferred name resolves in the next transaction exactly as it would have first", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedTwoAmbiguousNames(t);

    const first = await resolvePage(
      t,
      seed.variantTypeId,
      seed.sportId,
      seed.names,
      seed.cardTeams,
      { resume: { offset: 0 }, cardYearTeamReads: 1 },
    );
    const second = await resolvePage(
      t,
      seed.variantTypeId,
      seed.sportId,
      seed.names,
      seed.cardTeams,
      { resume: first.resume!, cardYearTeamReads: 1 },
    );

    expect(second.hasMore).toBe(false);
    expect(second.playerIdByName).toEqual([
      { name: "Cal Baker", id: seed.second.winner },
    ]);

    // The control: the same name walked FIRST, with no page boundary in front
    // of it. Identical answer — which is the guarantee the per-name budget was
    // chosen for, and the reason ending the page beats degrading the rest.
    const control = await resolvePage(
      t,
      seed.variantTypeId,
      seed.sportId,
      ["Cal Baker"],
      seed.cardTeams,
      { resume: { offset: 0 }, cardYearTeamReads: 1 },
    );
    expect(control.playerIdByName).toEqual(second.playerIdByName);
  });

  test("a page that has walked NOTHING still makes progress — the livelock guard", async () => {
    // `sweepAbandonedBatches` guards its reschedule on `rows > 0`; this is the
    // equivalent. A fresh cache starts at zero reads with a budget of at least
    // one, so the FIRST name of any page always gets its full allowance and
    // the walk can never stop where it started. Asserted at the tightest
    // possible ceiling, and with a name that needs more reads than the ceiling
    // allows.
    const t = convexTest(schema, modules);
    const seed = await seedTwoAmbiguousNames(t);

    const page = await resolvePage(
      t,
      seed.variantTypeId,
      seed.sportId,
      ["Bob Allen"],
      seed.cardTeams,
      { resume: { offset: 0 }, cardYearTeamReads: 0 },
    );

    expect(page.hasMore).toBe(false);
    expect(page.resume).toBeNull();
    expect(page.playerIdByName).toEqual([
      { name: "Bob Allen", id: seed.first.winner },
    ]);
  });
});

describe("NEO-296: the shared cache counts READS, and the ceiling cannot be raised", () => {
  test("a memo hit costs the transaction nothing, and a fresh read costs one", async () => {
    // The memo must stay a pure cost saving: it may change what a lookup
    // COSTS, never what it CONCLUDES, which is why the per-name budget is
    // charged on consultation and this one on the read.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1994");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const onPadres = await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1990, toYear: 1999 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1990, toYear: 1999 },
    ]);

    await t.run(async (ctx) => {
      const cache = createCardYearTeamCache();
      const candidates = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "allen bob").eq("sportId", sportId),
        )
        .collect();

      const first = await narrowSameNamePlayersByCardYear(ctx, candidates, {
        cardYear: 1994,
        cardTeamNames: ["San Diego Padres"],
        teamCache: cache,
      });
      expect(first.playerId).toBe(onPadres);
      const afterFirst = cache.reads;
      expect(afterFirst).toBeGreaterThan(0);

      // Same teams, so every lookup is a memo hit: the answer repeats and the
      // meter does not move.
      const second = await narrowSameNamePlayersByCardYear(ctx, candidates, {
        cardYear: 1994,
        cardTeamNames: ["San Diego Padres"],
        teamCache: cache,
      });
      expect(second.playerId).toBe(onPadres);
      expect(cache.reads).toBe(afterFirst);
    });
  });

  test("a spent cache defers the name instead of answering it on a spent budget", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1994");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1990, toYear: 1999 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1990, toYear: 1999 },
    ]);

    await t.run(async (ctx) => {
      const cache = createCardYearTeamCache({ budget: 2 });
      cache.reads = 2;
      const candidates = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "allen bob").eq("sportId", sportId),
        )
        .collect();

      const narrowed = await narrowSameNamePlayersByCardYear(ctx, candidates, {
        cardYear: 1994,
        cardTeamNames: ["San Diego Padres"],
        teamCache: cache,
      });

      // Flagged, and specifically NOT half a tie-break: no read was made.
      expect(narrowed.transactionBudgetExhausted).toBe(true);
      expect(narrowed.playerId).toBeNull();
      expect(cache.reads).toBe(2);
    });
  });

  test("the ceiling can only be lowered, never raised, and never to zero", async () => {
    // Same contract as `commitCardChecklistPrelude`'s `namesPerPage`: the
    // transaction's bound belongs to the transaction. `Infinity` is the one
    // exception, for the unpaged caller that has nowhere to resume to.
    expect(createCardYearTeamCache().budget).toBe(
      CARD_YEAR_TEAM_READS_PER_TRANSACTION,
    );
    expect(
      createCardYearTeamCache({
        budget: CARD_YEAR_TEAM_READS_PER_TRANSACTION * 10,
      }).budget,
    ).toBe(CARD_YEAR_TEAM_READS_PER_TRANSACTION);
    expect(createCardYearTeamCache({ budget: 5 }).budget).toBe(5);
    expect(createCardYearTeamCache({ budget: 0 }).budget).toBe(1);
    expect(
      createCardYearTeamCache({ budget: Number.POSITIVE_INFINITY }).budget,
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

// ===========================================================================
// NEO-424 rule D — the Hall of Fame tie-break
// ===========================================================================

/** A "Bob Allen" with an explicit Hall of Fame flag; `insertBobAllen` has none. */
async function insertFamer(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  hof: boolean,
  teamYears?: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      sportId,
      ...(teamYears ? { teamYears } : {}),
      ...(hof ? { isHallOfFame: true } : {}),
      lastUpdated: Date.now(),
    }),
  );
}

describe("NEO-424: Hall of Fame breaks a tie only when nobody was active in the card's year", () => {
  test("an active namesake in the set year beats the Hall of Famer", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const active = await insertFamer(t, sportId, false, [{ teamId: padres, fromYear: 2020 }]);
    await insertFamer(t, sportId, true, [{ teamId: padres, fromYear: 1951, toYear: 1966 }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024 });
    expect(resolved.playerId).toBe(active);
    // The year did it, not fame: the gate must treat this as a silent link.
    expect(resolved.narrowedBy).toBe("cardYear");
  });

  test("two active namesakes and a retired Hall of Famer is still review", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertFamer(t, sportId, false, [{ teamId: padres, fromYear: 2020 }]);
    await insertFamer(t, sportId, false, [{ teamId: padres, fromYear: 2022 }]);
    await insertFamer(t, sportId, true, [{ teamId: padres, fromYear: 1951, toYear: 1966 }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024 });
    expect(resolved.matchCount).toBe(3);
    expect(resolved.playerId).toBeUndefined();
  });

  test("an active Hall of Famer and an active non-Famer is review: fame does not break an active tie", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertFamer(t, sportId, true, [{ teamId: padres, fromYear: 2010 }]);
    await insertFamer(t, sportId, false, [{ teamId: padres, fromYear: 2020 }]);

    expect((await resolve(t, { sportId, cardYear: 2024 })).playerId).toBeUndefined();
  });

  test("two Hall of Famers, nobody active, is review", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertFamer(t, sportId, true, [{ teamId: padres, fromYear: 1951, toYear: 1966 }]);
    await insertFamer(t, sportId, true, [{ teamId: padres, fromYear: 1930, toYear: 1945 }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024 });
    expect(resolved.playerId).toBeUndefined();
    expect(resolved.candidatePlayerIds).toHaveLength(2);
  });

  test("no Hall of Famer among legends of a modern card is review", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertFamer(t, sportId, false, [{ teamId: padres, fromYear: 1951, toYear: 1966 }]);
    await insertFamer(t, sportId, false, [{ teamId: padres, fromYear: 1930, toYear: 1945 }]);

    expect((await resolve(t, { sportId, cardYear: 2024 })).playerId).toBeUndefined();
  });

  test("with survivors, the pool is the survivors: a retired Hall of Famer outside them does not win", async () => {
    // Two namesakes with no dated career are never excluded by the year, so
    // both survive, and neither is KNOWN active. The third is a Hall of Famer
    // the year ruled out. Only the survivors are weighed, and neither is one.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    await insertFamer(t, sportId, false);
    await insertFamer(t, sportId, false);
    await insertFamer(t, sportId, true, [{ teamId: padres, fromYear: 1951, toYear: 1966 }]);

    expect((await resolve(t, { sportId, cardYear: 2024 })).playerId).toBeUndefined();
  });

  test("with survivors, a Hall of Famer among them wins", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    await insertFamer(t, sportId, false);
    const famer = await insertFamer(t, sportId, true);

    const resolved = await resolve(t, { sportId, cardYear: 2024 });
    expect(resolved.playerId).toBe(famer);
    expect(resolved.narrowedBy).toBe("hallOfFame");
  });

  test("a rival's stint on the card's team, in ANY year, holds the Hall of Famer back", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const famer = await insertFamer(t, sportId, true, [
      { teamId: cubs, fromYear: 1951, toYear: 1966 },
    ]);
    // The rival's Padres years are nowhere near the card's year.
    const rival = await insertFamer(t, sportId, false, [
      { teamId: padres, fromYear: 1930, toYear: 1937 },
    ]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });
    expect(resolved.playerId).not.toBe(famer);
    // NEO-490 — the card's team is the evidence, and only the rival ever
    // played for it, so rule 6b (career team) names him.
    expect(resolved.playerId).toBe(rival);
    expect(resolved.narrowedBy).toBe("careerTeam");
  });

  test("the Hall of Famer's OWN team on the card supports him, and a third team blocks nobody", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "diego padres san");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const mets = await insertTeam(t, sportId, "New York", "Mets", "mets new york");
    const famer = await insertFamer(t, sportId, true, [
      { teamId: cubs, fromYear: 1951, toYear: 1966 },
    ]);
    await insertFamer(t, sportId, false, [{ teamId: padres, fromYear: 1930, toYear: 1937 }]);

    for (const team of ["Chicago Cubs", "Cubs", "New York Mets"]) {
      const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: [team] });
      expect(resolved.playerId, team).toBe(famer);
    }
    void mets;
  });

  test("a rival whose stint points at a deleted team cannot block him", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const ghostTeam = await insertTeam(t, sportId, "Ghost", "Town", "ghost town");
    const famer = await insertFamer(t, sportId, true);
    await insertFamer(t, sportId, false, [{ teamId: ghostTeam, fromYear: 1930, toYear: 1937 }]);
    await t.run(async (ctx) => ctx.db.delete(ghostTeam));

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });
    expect(resolved.playerId).toBe(famer);
  });

  test("no card year means no Hall of Fame guess", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    await insertFamer(t, sportId, true);
    await insertFamer(t, sportId, false);

    expect((await resolve(t, { sportId })).playerId).toBeUndefined();
  });
});

describe("NEO-424: the commit prelude applies the Hall of Fame tie-break to a name with no review row", () => {
  test("a lone Hall of Famer gets the card, and the narrowing is logged by id", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, ids.sportId, "San Diego", "Padres", "diego padres san");
    const famer = await insertFamer(t, ids.sportId, true, [
      { teamId: padres, fromYear: 1951, toYear: 1966 },
    ]);
    await insertFamer(t, ids.sportId, false, [{ teamId: padres, fromYear: 1930, toYear: 1937 }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const cards = await commit(t, ids, [makeCard({ players: ["Bob Allen"] })]);
      expect(cards[0].playerIds).toEqual([famer]);
      const lines = log.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("player_narrowed_by_hall_of_fame"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ playerId: famer, matchCount: 2 });
      expect(lines[0]).not.toContain("Bob Allen");
    } finally {
      log.mockRestore();
    }
    expect(await t.run(async (ctx) => ctx.db.query("players").collect())).toHaveLength(2);
  });

  test("an operator's link to the other man beats the Hall of Fame tie-break", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "2024");
    await insertFamer(t, ids.sportId, true);
    const operatorsPick = await insertFamer(t, ids.sportId, false);
    await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: ids.variantTypeId,
        batchId: "batch-hof",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player" as const,
        name: "Bob Allen",
        sportId: ids.sportId,
        status: "ready" as const,
        decision: { action: "link" as const, linkedPlayerId: operatorsPick },
      }),
    );

    const cards = await commit(t, ids, [makeCard({ players: ["Bob Allen"] })], "batch-hof");
    expect(cards[0].playerIds).toEqual([operatorsPick]);
  });

  test("two Hall of Famers leave the card unlinked", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedSetOfYear(t, "2024");
    await insertFamer(t, ids.sportId, true);
    await insertFamer(t, ids.sportId, true);

    const cards = await commit(t, ids, [makeCard({ players: ["Bob Allen"] })]);
    expect(cards[0].playerIds ?? []).toEqual([]);
    expect(cards[0].pendingPlayerNames).toContain("Bob Allen");
  });
});

// ===========================================================================
// NEO-490 rule 6b — the career-team tie-break
// ===========================================================================

/** Stints long before any card year these tests use, so no span covers it. */
const LONG_AGO = { fromYear: 1930, toYear: 1937 };

describe("NEO-490: the career-team tie-break (rule 6b) names the one namesake who ever played for the card's team", () => {
  test("one career stint on the card's team wins, reported as careerTeam", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const onPadres = await insertBobAllen(t, sportId, [{ teamId: padres, ...LONG_AGO }]);
    await insertBobAllen(t, sportId, [{ teamId: cubs, ...LONG_AGO }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });

    expect(resolved.playerId).toBe(onPadres);
    expect(resolved.narrowedBy).toBe("careerTeam");
    expect(resolved.narrowedByCardYear).toBe(true);
  });

  test("a stint in ANY year counts, not only the card's year", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    await insertBobAllen(t, sportId, [{ teamId: cubs, fromYear: 1960, toYear: 1965 }]);
    const early = await insertBobAllen(t, sportId, [
      { teamId: cubs, fromYear: 1970, toYear: 1971 },
      { teamId: padres, fromYear: 1972, toYear: 1974 },
    ]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });
    expect(resolved.playerId).toBe(early);
  });

  test("a rival with no career on file sends the name to review", async () => {
    // A namesake with no stints has an unknown career, and unknown is not
    // absent: he could have played for the card's team too. (Two such rivals
    // here: a lone career-less namesake would be the year's only survivor and
    // win by rule 5, which is a different rule.)
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    await insertBobAllen(t, sportId, [{ teamId: padres, ...LONG_AGO }]);
    await insertBobAllen(t, sportId);
    await insertBobAllen(t, sportId);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });

    expect(resolved.playerId).toBeUndefined();
    expect(resolved.narrowedBy).toBeUndefined();
    expect(resolved.matchCount).toBe(3);
  });

  test("two namesakes who both played for the card's team go to review", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    await insertBobAllen(t, sportId, [{ teamId: padres, ...LONG_AGO }]);
    await insertBobAllen(t, sportId, [{ teamId: padres, fromYear: 1950, toYear: 1955 }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });

    expect(resolved.playerId).toBeUndefined();
    expect(resolved.matchCount).toBe(2);
  });

  test("two namesakes with stints on the card's team in different eras, among other clubs: rule 6b does not decide", async () => {
    // Collector review (NEO-490): the second Bob Allen reached the Padres
    // twenty years after the first, mid-way through a longer career. Each is
    // "a namesake who played for the card's team", so the career-team rule
    // has two answers and must give none; neither era is the card's year, so
    // no year rule can separate them either.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const mets = await insertTeam(t, sportId, "New York", "Mets", "mets new york");
    await insertBobAllen(t, sportId, [
      { teamId: padres, fromYear: 1972, toYear: 1975 },
      { teamId: cubs, fromYear: 1976, toYear: 1978 },
    ]);
    await insertBobAllen(t, sportId, [
      { teamId: mets, fromYear: 1990, toYear: 1993 },
      { teamId: cubs, fromYear: 1994, toYear: 1995 },
      { teamId: padres, fromYear: 1996, toYear: 1998 },
    ]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });

    expect(resolved.playerId).toBeUndefined();
    expect(resolved.narrowedBy).toBeUndefined();
    expect(resolved.matchCount).toBe(2);

    // The narrowing itself, so the reason is pinned too, not only the gate.
    await t.run(async (ctx) => {
      const candidates = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "allen bob").eq("sportId", sportId),
        )
        .collect();
      const narrowed = await narrowSameNamePlayersByCardYear(ctx, candidates, {
        cardYear: 2024,
        cardTeamNames: ["San Diego Padres"],
      });
      expect(narrowed.playerId).toBeNull();
      expect(narrowed.viaCareerTeam).toBeUndefined();
      expect(narrowed.transactionBudgetExhausted).toBeUndefined();
    });
  });

  test("nobody ever played for the card's team: review", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const mets = await insertTeam(t, sportId, "New York", "Mets", "mets new york");
    await insertBobAllen(t, sportId, [{ teamId: cubs, ...LONG_AGO }]);
    await insertBobAllen(t, sportId, [{ teamId: mets, ...LONG_AGO }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });
    expect(resolved.playerId).toBeUndefined();
  });

  test("a card naming no team never reaches it", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    await insertBobAllen(t, sportId, [{ teamId: padres, ...LONG_AGO }]);
    await insertBobAllen(t, sportId, [{ teamId: cubs, ...LONG_AGO }]);

    expect((await resolve(t, { sportId, cardYear: 2024 })).playerId).toBeUndefined();
  });

  test("when the Hall of Fame rule fires, 6b never runs", async () => {
    // The Hall of Famer's own team is on the card and no rival played there,
    // so rule 6 answers. Rule 6b would have named the same man, which is why
    // the REASON is what proves the order: hallOfFame, never careerTeam.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const famer = await insertFamer(t, sportId, true, [{ teamId: cubs, fromYear: 1951, toYear: 1966 }]);
    await insertFamer(t, sportId, false, [{ teamId: padres, ...LONG_AGO }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Chicago Cubs"] });

    expect(resolved.playerId).toBe(famer);
    expect(resolved.narrowedBy).toBe("hallOfFame");
  });

  test("a lone year-survivor still wins by rule 5, even when a rival ever played for the card's team", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const active = await insertBobAllen(t, sportId, [{ teamId: cubs, fromYear: 2020 }]);
    await insertBobAllen(t, sportId, [{ teamId: padres, ...LONG_AGO }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: ["Padres"] });

    expect(resolved.playerId).toBe(active);
    expect(resolved.narrowedBy).toBe("cardYear");
  });

  test.each([
    ["the nickname", "Padres"],
    ["the full name", "San Diego Padres"],
    ["the full name in another case", "san diego padres"],
  ])("the card naming the team by %s matches its stint", async (_label, cardTeam) => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const onPadres = await insertBobAllen(t, sportId, [{ teamId: padres, ...LONG_AGO }]);
    await insertBobAllen(t, sportId, [{ teamId: cubs, ...LONG_AGO }]);

    const resolved = await resolve(t, { sportId, cardYear: 2024, cardTeamNames: [cardTeam] });
    expect(resolved.playerId).toBe(onPadres);
  });
});

describe("NEO-490: rule 6b is bounded, and a bound always means review", () => {
  /** `count` old teams "Club0".."Club<count-1>" in one sport. */
  async function seedClubs(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    count: number,
  ) {
    const ids: Id<"teams">[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(await insertTeam(t, sportId, `City${i}`, `Club${i}`, `city${i} club${i}`));
    }
    return ids;
  }

  /**
   * One namesake whose career covers `clubs` (the card names the LAST of
   * them), and a rival parked on the first club so he adds no consultation.
   */
  async function seedLongCareer(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    clubs: Id<"teams">[],
  ) {
    const longCareer = await insertBobAllen(
      t,
      sportId,
      clubs.map((teamId) => ({ teamId, ...LONG_AGO })),
    );
    await insertBobAllen(t, sportId, [{ teamId: clubs[0], ...LONG_AGO }]);
    return longCareer;
  }

  test("a name consulting exactly the allowance still resolves", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const clubs = await seedClubs(t, sportId, CAREER_TEAM_READS_PER_NAME);
    const longCareer = await seedLongCareer(t, sportId, clubs);

    const resolved = await resolve(t, {
      sportId,
      cardYear: 2024,
      cardTeamNames: [`City${clubs.length - 1} Club${clubs.length - 1}`],
    });

    expect(resolved.playerId).toBe(longCareer);
    expect(resolved.narrowedBy).toBe("careerTeam");
  });

  test("one team past the allowance is review, never a guess on half the careers", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const clubs = await seedClubs(t, sportId, CAREER_TEAM_READS_PER_NAME + 1);
    await seedLongCareer(t, sportId, clubs);

    const resolved = await resolve(t, {
      sportId,
      cardYear: 2024,
      cardTeamNames: [`City${clubs.length - 1} Club${clubs.length - 1}`],
    });

    expect(resolved.playerId).toBeUndefined();
    expect(resolved.matchCount).toBe(2);
  });

  test("when rule 4's allowance is already blown, 6b does not run", async () => {
    // Same fixture as NEO-296's per-name budget test: twelve concurrent stints
    // in the card's year, the card names the twelfth. Rule 4 is abandoned. 6b
    // reads the same career and WOULD name him (he is the only one on that
    // team), so a name that comes back unresolved proves it stood down.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "1994");
    const clubs = await seedClubs(t, sportId, 12);
    const other = await insertTeam(t, sportId, "Elsewhere", "Nine", "elsewhere nine");
    await insertBobAllen(
      t,
      sportId,
      clubs.map((teamId) => ({ teamId, fromYear: 1990, toYear: 1999 })),
    );
    await insertBobAllen(t, sportId, [{ teamId: other, fromYear: 1993, toYear: 1995 }]);

    const resolved = await resolve(t, {
      sportId,
      cardYear: 1994,
      cardTeamNames: ["City11 Club11"],
    });

    expect(resolved.playerId).toBeUndefined();
    expect(resolved.narrowedBy).toBeUndefined();
  });

  test("a spent shared cache defers the name whole, reading nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    await insertBobAllen(t, sportId, [{ teamId: padres, ...LONG_AGO }]);
    await insertBobAllen(t, sportId, [{ teamId: cubs, ...LONG_AGO }]);

    await t.run(async (ctx) => {
      const cache = createCardYearTeamCache({ budget: 2 });
      cache.reads = 2;
      const candidates = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "allen bob").eq("sportId", sportId),
        )
        .collect();

      const narrowed = await narrowSameNamePlayersByCardYear(ctx, candidates, {
        cardYear: 2024,
        cardTeamNames: ["Padres"],
        teamCache: cache,
      });

      expect(narrowed.transactionBudgetExhausted).toBe(true);
      expect(narrowed.playerId).toBeNull();
      expect(narrowed.viaCareerTeam).toBeUndefined();
      expect(cache.reads).toBe(2);
    });
  });

  test("a fresh shared cache lets it answer and meters its reads", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSetOfYear(t, "2024");
    const padres = await insertTeam(t, sportId, "San Diego", "Padres", "padres san diego");
    const cubs = await insertTeam(t, sportId, "Chicago", "Cubs", "chicago cubs");
    const onPadres = await insertBobAllen(t, sportId, [{ teamId: padres, ...LONG_AGO }]);
    await insertBobAllen(t, sportId, [{ teamId: cubs, ...LONG_AGO }]);

    await t.run(async (ctx) => {
      const cache = createCardYearTeamCache();
      const candidates = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", "allen bob").eq("sportId", sportId),
        )
        .collect();

      const narrowed = await narrowSameNamePlayersByCardYear(ctx, candidates, {
        cardYear: 2024,
        cardTeamNames: ["Padres"],
        teamCache: cache,
      });

      expect(narrowed).toMatchObject({ playerId: onPadres, viaCareerTeam: true });
      expect(cache.reads).toBeGreaterThan(0);
    });
  });
});
