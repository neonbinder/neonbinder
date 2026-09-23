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
