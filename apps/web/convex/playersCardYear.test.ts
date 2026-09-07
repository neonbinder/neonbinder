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
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

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
  },
) {
  return t.query(internal.players.resolveNameForReview, {
    name: "Bob Allen",
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
