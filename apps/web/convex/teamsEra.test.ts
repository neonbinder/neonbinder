/**
 * NEO-254 — two Winnipeg Jets, and every path that has to tell them apart.
 *
 * ## The lineage bug
 *
 * The Jets that played 1972-1996 became the Phoenix Coyotes and then Utah. The
 * Jets that started in 2011 are the old Atlanta Thrashers under a revived name.
 * Different franchises, different players, different cards — and under the
 * NEO-236 identity key `(nameNormalized, sportId)` they folded into ONE row, so
 * a 1985 card and a 2015 card both pointed at whichever row the index happened
 * to return first. Jason, at the hockey checkpoint: "lets fix the lineage issue
 * now … when we are done loading, all of the data is correct."
 *
 * Identity is now `(nameNormalized, sportId, yearsActive.from)`.
 *
 * ## What this file pins
 *
 * The name still does the FINDING; the era does the TELLING APART. Every
 * surface that turns a team name into a team id has to narrow by a year, and
 * every one that fails to narrow has to ask a human rather than pick. Those two
 * halves are the whole ticket, and each test below is one path through them.
 *
 * The `.first()` shape this replaces is the thing to watch for in review: it
 * reads as correct, it type-checks, and it silently binds a card to the wrong
 * franchise. `convex/teams.dedupPin.test.ts` greps for its return.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };
const SIGNED_IN = { subject: "user" };

type T = ReturnType<typeof convexTest>;

const JETS = "Winnipeg Jets";

/**
 * A sport, a year row under it and a set under that — the shape
 * `findSetYearForSelectorOption` walks. The set is what a commit is about, and
 * its year is the evidence every narrowing here runs on.
 */
async function seedSportWithSet(
  t: T,
  year: string,
): Promise<{ sportId: Id<"selectorOptions">; setId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      platformData: {},
      children: [],
      lastUpdated: 1,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: year,
      parentId: sportId,
      platformData: {},
      children: [],
      lastUpdated: 1,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: `${year} O-Pee-Chee`,
      parentId: yearId,
      platformData: {},
      children: [],
      lastUpdated: 1,
    });
    return { sportId, setId };
  });
}

/** Both Jets rows, in lineage order. */
async function seedBothJets(
  t: T,
  sportId: Id<"selectorOptions">,
): Promise<{ old: Id<"teams">; revived: Id<"teams"> }> {
  return t.run(async (ctx) => {
    const old = await ctx.db.insert("teams", {
      name: "Jets",
      location: "Winnipeg",
      nameNormalized: normalizeTeamName(JETS),
      sportId,
      yearsActive: { from: 1972, to: 1996 },
      lastUpdated: 1,
    });
    const revived = await ctx.db.insert("teams", {
      name: "Jets",
      location: "Winnipeg",
      nameNormalized: normalizeTeamName(JETS),
      sportId,
      yearsActive: { from: 2011 },
      lastUpdated: 1,
    });
    return { old, revived };
  });
}

// ---------------------------------------------------------------------------
// The identity itself
// ---------------------------------------------------------------------------

describe("a sport may hold two teams under one name", () => {
  test("both rows coexist, and the index returns both", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const { old, revived } = await seedBothJets(t, sportId);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", normalizeTeamName(JETS)).eq("sportId", sportId),
        )
        .collect(),
    );
    expect(rows.map((r) => r._id).sort()).toEqual([old, revived].sort());
  });

  test("the eras are offered as a choice, oldest first", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const { old, revived } = await seedBothJets(t, sportId);

    const eras = await t
      .withIdentity(SIGNED_IN)
      .query(api.teams.erasByNameAndSport, { name: JETS, sportId });

    expect(eras.map((e) => [e._id, e.label])).toEqual([
      [old, "Winnipeg Jets · 1972–1996"],
      [revived, "Winnipeg Jets · 2011–present"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Card → team resolution
// ---------------------------------------------------------------------------

describe("a card's team name resolves by the set's year", () => {
  test.each([
    ["1985", "old" as const],
    ["2015", "revived" as const],
  ])("a %s set means the %s Jets", async (year, which) => {
    const t = convexTest(schema, modules);
    const { sportId, setId } = await seedSportWithSet(t, year);
    const jets = await seedBothJets(t, sportId);

    const setYear = await t.query(
      internal.selectorOptions.findSetYearForSelectorOptionQuery,
      { selectorOptionId: setId },
    );
    expect(setYear).toBe(Number(year));

    const resolved = await t.query(internal.teams.findByFullNameInternal, {
      name: JETS,
      sportId,
      setYear: setYear ?? undefined,
    });
    expect(resolved).toBe(jets[which]);
  });

  test("with NO set year, neither wins — the name goes to a human", async () => {
    // The rule the whole design rests on: the year is the evidence, and with no
    // evidence the answer is a person. Returning either row here would be the
    // original defect with extra steps.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    await seedBothJets(t, sportId);

    await expect(
      t.query(internal.teams.findByFullNameInternal, { name: JETS, sportId }),
    ).resolves.toBeNull();
  });

  test("a year covered by NEITHER era is also a human's problem", async () => {
    // 2005: the first Jets had folded, the second had not started. Nothing on
    // file is right, and picking the nearest would be a guess.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "2005");
    await seedBothJets(t, sportId);

    await expect(
      t.query(internal.teams.findByFullNameInternal, {
        name: JETS,
        sportId,
        setYear: 2005,
      }),
    ).resolves.toBeNull();
  });

  test("an UNDATED third row keeps every year ambiguous", async () => {
    // Unknown is not absent. A row nobody has dated could be either franchise,
    // so it survives every filter and keeps the answer a question.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    await seedBothJets(t, sportId);
    await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName(JETS),
        sportId,
        lastUpdated: 1,
      }),
    );

    await expect(
      t.query(internal.teams.findByFullNameInternal, {
        name: JETS,
        sportId,
        setYear: 1985,
      }),
    ).resolves.toBeNull();
  });

  test("a lone UNDATED row is still the row, whatever the year", async () => {
    // Unknown years cannot contradict anything, so an undated row answers for
    // every set. This is the pre-existing behaviour, and it must not start
    // costing an operator a decision.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const only = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Oilers",
        location: "Edmonton",
        nameNormalized: normalizeTeamName("Edmonton Oilers"),
        sportId,
        lastUpdated: 1,
      }),
    );

    for (const setYear of [undefined, 1985, 1800]) {
      await expect(
        t.query(internal.teams.findByFullNameInternal, {
          name: "Edmonton Oilers",
          sportId,
          ...(setYear !== undefined ? { setYear } : {}),
        }),
      ).resolves.toBe(only);
    }
  });

  test("a lone DATED row answers only for the years it covers", async () => {
    /*
     * The subtler half of the rule, and the one with no second row to make the
     * mistake visible.
     *
     * A single row dated 2011- is positive evidence that a 1985 card does NOT
     * mean it. Linking anyway is the same wrong answer the two-Jets case
     * produces, just quieter: the operator sees a card filed under a franchise
     * that did not exist, with nothing anywhere saying so. So the year rules it
     * out exactly as it would rule out one of several rivals — we hold a
     * Winnipeg Jets, it is not this one, and a human decides whether the other
     * era needs creating.
     */
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const revived = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName(JETS),
        sportId,
        yearsActive: { from: 2011 },
        lastUpdated: 1,
      }),
    );

    // Inside its era: the row.
    await expect(
      t.query(internal.teams.findByFullNameInternal, {
        name: JETS,
        sportId,
        setYear: 2015,
      }),
    ).resolves.toBe(revived);

    // Outside it: not an answer.
    await expect(
      t.query(internal.teams.findByFullNameInternal, {
        name: JETS,
        sportId,
        setYear: 1985,
      }),
    ).resolves.toBeNull();

    // …and with no year at all it still answers, because nothing contradicts
    // it. No evidence is not counter-evidence.
    await expect(
      t.query(internal.teams.findByFullNameInternal, { name: JETS, sportId }),
    ).resolves.toBe(revived);
  });
});

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

describe("teams.findOrCreate — finding an era, and making one", () => {
  test("an overlapping era is FOUND, not duplicated", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const { old } = await seedBothJets(t, sportId);

    const found = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Jets",
      location: "Winnipeg",
      sportId,
      yearsActive: { from: 1980, to: 1990 },
    });
    expect(found).toBe(old);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(2);
  });

  test("a new era is refused first, and the refusal NAMES the others", async () => {
    // Creating a second row under an existing name is real and necessary — and
    // it is also exactly what a typo looks like. The refusal is the
    // confirmation prompt.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName(JETS),
        sportId,
        yearsActive: { from: 1972, to: 1996 },
        lastUpdated: 1,
      }),
    );

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
        name: "Jets",
        location: "Winnipeg",
        sportId,
        yearsActive: { from: 2011 },
      }),
    ).rejects.toThrow(/1972–1996/);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });

  test("…and goes through once the operator confirms the era", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName(JETS),
        sportId,
        yearsActive: { from: 1972, to: 1996 },
        lastUpdated: 1,
      }),
    );

    const created = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Jets",
      location: "Winnipeg",
      sportId,
      yearsActive: { from: 2011 },
      newEra: true,
    });

    const rows = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r._id === created)?.yearsActive).toEqual({ from: 2011 });
  });

  test("with no years at all the old find-or-create behaviour is unchanged", async () => {
    // An undated side counts as overlapping, so a caller that knows no years
    // still finds the single row it always did and cannot fork beside it.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const first = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "Oilers", location: "Edmonton", sportId });
    const second = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "Oilers", location: "Edmonton", sportId });
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Team Management's save
// ---------------------------------------------------------------------------

describe("saveTeamFields collides only on an overlapping era", () => {
  test("renaming onto a same-name row with a DISJOINT era is allowed", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName(JETS),
        sportId,
        yearsActive: { from: 1972, to: 1996 },
        lastUpdated: 1,
      }),
    );
    // The 2011 franchise, still filed under its Atlanta name.
    const thrashers = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Thrashers",
        location: "Atlanta",
        nameNormalized: normalizeTeamName("Atlanta Thrashers"),
        sportId,
        yearsActive: { from: 2011 },
        lastUpdated: 1,
      }),
    );

    await t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
      id: thrashers,
      name: "Jets",
      location: "Winnipeg",
    });

    const row = await t.run(async (ctx) => ctx.db.get(thrashers));
    expect(row?.name).toBe("Jets");
    expect(row?.location).toBe("Winnipeg");
  });

  test("renaming onto an OVERLAPPING era is still refused", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const old = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName(JETS),
        sportId,
        yearsActive: { from: 1972, to: 1996 },
        lastUpdated: 1,
      }),
    );
    const other = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Thrashers",
        location: "Atlanta",
        nameNormalized: normalizeTeamName("Atlanta Thrashers"),
        sportId,
        yearsActive: { from: 1990, to: 2000 },
        lastUpdated: 1,
      }),
    );

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
        id: other,
        name: "Jets",
        location: "Winnipeg",
      }),
    ).rejects.toThrow(`NAME_TAKEN:${old}`);
  });

  test("WIDENING an era back over its neighbour is refused too", async () => {
    // The gap this closes: without checking the years edit, an operator could
    // separate the two Jets by narrowing one era and then silently re-merge
    // them by widening it again, with no refusal anywhere.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const { old, revived } = await seedBothJets(t, sportId);

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
        id: revived,
        yearsActive: { from: 1990 },
      }),
    ).rejects.toThrow(`NAME_TAKEN:${old}`);

    const row = await t.run(async (ctx) => ctx.db.get(revived));
    expect(row?.yearsActive).toEqual({ from: 2011 });
  });

  test("an ordinary years edit that stays clear of the neighbour is fine", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const { revived } = await seedBothJets(t, sportId);

    await t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
      id: revived,
      yearsActive: { from: 2011, to: 2030 },
    });
    const row = await t.run(async (ctx) => ctx.db.get(revived));
    expect(row?.yearsActive).toEqual({ from: 2011, to: 2030 });
  });
});

// ---------------------------------------------------------------------------
// The "did you mean?" prompt
// ---------------------------------------------------------------------------

describe("teams.nearMatches offers every era, labelled", () => {
  test("both Jets come back, each with its years", async () => {
    // Two identical "Winnipeg Jets" entries in a duplicate-warning list are
    // worse than useless — and they would give the panel two byte-identical
    // accessible names.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    await seedBothJets(t, sportId);

    const matches = await t
      .withIdentity(ADMIN)
      .query(api.teams.nearMatches, { name: JETS, sportId });

    const exact = matches.filter((m) => m.confidence === "exact");
    // BOTH rows, where `.first()` used to offer one of them at random.
    expect(exact).toHaveLength(2);
    // `name` stays bare so `rankTeamCandidates` still scores it as exact; the
    // era rides alongside so the panel can build a unique label from it.
    expect(exact.map((m) => m.name)).toEqual(["Winnipeg Jets", "Winnipeg Jets"]);
    expect(exact.map((m) => m.yearsActive).sort((a, b) => a!.from - b!.from)).toEqual([
      { from: 1972, to: 1996 },
      { from: 2011 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// End to end: the operator creates the second era, and a 1985 card finds it
// ---------------------------------------------------------------------------

describe("the review wizard's era reaches the row, and the card", () => {
  test("an operator-typed era creates a second Jets beside the 2011 one", async () => {
    /*
     * The whole ticket in one path.
     *
     * The deployment already holds the 2011 Winnipeg Jets (the colour seed and
     * the current-roster loads both produce it). A 1985 set names "Winnipeg
     * Jets"; the name resolves to a row whose era excludes 1985, so it reaches
     * the review wizard rather than being linked. The operator answers with the
     * historical era, and the commit has to CREATE beside the existing row —
     * not adopt it, not refuse — and then link the card to the one it made.
     *
     * `create.yearsActive` is what carries their answer, and it has to outrank
     * `enrichment.yearsActive`: the lookup describes whichever Jets Wikidata
     * matched, which is exactly the row the operator is trying to distinguish
     * this one from.
     */
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { sportId, setId } = await seedSportWithSet(t, "1985");
    const revived = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName(JETS),
        sportId,
        yearsActive: { from: 2011 },
        lastUpdated: 1,
      }),
    );

    await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: setId,
        sportId,
        batchId: "batch-era",
        createdByUserId: "admin",
        kind: "team",
        name: JETS,
        nameNormalized: normalizeTeamName(JETS),
        status: "ready",
        decision: {
          action: "create",
          create: {
            location: "Winnipeg",
            name: "Jets",
            // The operator's own answer.
            yearsActive: { from: 1972, to: 1996 },
          },
        },
        // …and the lookup describing the OTHER franchise, which must lose.
        enrichment: { yearsActive: { from: 2011 } },
      }),
    );

    const prelude = await asAdmin.mutation(
      internal.selectorOptions.commitCardChecklistPrelude,
      {
        selectorOptionId: setId,
        sportId,
        playerNames: [],
        teamNames: [JETS],
        batchId: "batch-era",
      },
    );

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", normalizeTeamName(JETS)).eq("sportId", sportId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(2);

    const created = rows.find((r) => r._id !== revived)!;
    // The operator's era, not the enrichment's — the assertion this test exists
    // for. `{ from: 2011 }` here would mean the lookup overwrote the answer.
    expect(created.yearsActive).toEqual({ from: 1972, to: 1996 });
    expect(prelude.unresolvedTeamNames).toEqual([]);

    // …and the 1985 card resolves to the new row rather than the 2011 one.
    await expect(
      t.query(internal.teams.findByFullNameInternal, {
        name: JETS,
        sportId,
        setYear: 1985,
      }),
    ).resolves.toBe(created._id);
    await expect(
      t.query(internal.teams.findByFullNameInternal, {
        name: JETS,
        sportId,
        setYear: 2015,
      }),
    ).resolves.toBe(revived);
  });
});

// ---------------------------------------------------------------------------
// The gaps the review named
// ---------------------------------------------------------------------------

describe("findOrCreate refuses a mess rather than adding to it", () => {
  test("two OVERLAPPING same-name rows: refused, with their eras named", async () => {
    // Two rows sharing a name and an era means the data is already wrong. The
    // picker cannot rule between them and must not mint a third; the operator
    // is sent to the one screen that can sort it out.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    for (const yearsActive of [{ from: 1972, to: 1996 }, { from: 1990 }]) {
      await t.run(async (ctx) =>
        ctx.db.insert("teams", {
          name: "Jets",
          location: "Winnipeg",
          nameNormalized: normalizeTeamName(JETS),
          sportId,
          yearsActive,
          lastUpdated: 1,
        }),
      );
    }

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
        name: "Jets",
        location: "Winnipeg",
        sportId,
        yearsActive: { from: 1993, to: 1995 },
      }),
    ).rejects.toThrow(/Team Management/);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(2);
  });

  test("newEra with NO years beside an undated row returns the existing row", async () => {
    /*
     * `newEra` is a confirmation, not an override.
     *
     * With no years the incoming team overlaps everything — an undated side is
     * unknown, and unknown cannot be ruled out — so the collision check finds
     * the existing row and returns it BEFORE `newEra` is ever consulted. That
     * ordering is deliberate: creating a second era requires saying when it
     * played, which is the right bar for a decision that permanently splits a
     * name, and it stops `newEra: true` becoming a way to mint duplicates that
     * nothing can later tell apart.
     */
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const undated = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: normalizeTeamName(JETS),
        sportId,
        lastUpdated: 1,
      }),
    );

    const found = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Jets",
      location: "Winnipeg",
      sportId,
      newEra: true,
    });
    expect(found).toBe(undated);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });
});

describe("saveTeamFields — clearing an era", () => {
  test("clearing years beside a DATED same-name row is refused", async () => {
    // Clearing makes the row undated, and an undated row overlaps everything —
    // so it collides with the sibling era it was separated from. Refusing is
    // the same rule as widening, reached from the other direction: an operator
    // must not be able to re-merge two franchises by emptying a box.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const { old, revived } = await seedBothJets(t, sportId);

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
        id: revived,
        yearsActive: null,
      }),
    ).rejects.toThrow(`NAME_TAKEN:${old}`);
    expect(
      await t.run(async (ctx) => (await ctx.db.get(revived))?.yearsActive),
    ).toEqual({ from: 2011 });
  });

  test("clearing years on a row with NO same-name sibling is fine", async () => {
    // The permission this keeps: an era is optional, and a lone row may lose
    // one without ceremony.
    const t = convexTest(schema, modules);
    const { sportId } = await seedSportWithSet(t, "1985");
    const lone = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Oilers",
        location: "Edmonton",
        nameNormalized: normalizeTeamName("Edmonton Oilers"),
        sportId,
        yearsActive: { from: 1972 },
        lastUpdated: 1,
      }),
    );

    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.saveTeamFields, { id: lone, yearsActive: null });
    // `t.run`'s return crosses the Convex value boundary, where an absent
    // optional arrives as `null` rather than `undefined`.
    expect(
      await t.run(async (ctx) => (await ctx.db.get(lone))?.yearsActive ?? null),
    ).toBeNull();
  });
});

describe("the card-linking paths narrow by the set's year", () => {
  /**
   * `backfillTeamToOnCardIds` and `applyBscTeamResolution` both turn a team
   * STRING on a card into a team id. Both used `.first()`; both now ask about
   * the card's own set year, and both treat "several eras, none decisive" the
   * same way they already treated "no such team" — the string is kept, nothing
   * is linked, and an operator decides.
   */
  const seedCard = async (
    t: T,
    setId: Id<"selectorOptions">,
    team: string,
  ): Promise<Id<"cardChecklist">> =>
    t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: setId,
        cardNumber: "1",
        cardName: "Dale Hawerchuk",
        // The legacy free-text field the backfill reads. `as never` bypasses
        // the schema validator, exactly as `teamBackfill.test.ts` does — only
        // pre-NEO-26 rows carry it, which is the point of a backfill.
        team,
        platformData: {},
        sortOrder: 1,
        lastUpdated: 1,
      } as never),
    );

  test("the backfill links a 1985 card to the 1985 era", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setId } = await seedSportWithSet(t, "1985");
    const { old } = await seedBothJets(t, sportId);
    const cardId = await seedCard(t, setId, JETS);

    await t.mutation(internal.cardChecklist.backfillTeamToOnCardIds, {
      batchSize: 10,
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card?.teamOnCardIds).toEqual([old]);
  });

  test("…and leaves the string alone when the year cannot separate the eras", async () => {
    // No year row above this set, so there is no evidence — and the answer to
    // no evidence is a human, not the first row an index returned.
    const t = convexTest(schema, modules);
    const sportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Hockey",
        platformData: {},
        children: [],
        lastUpdated: 1,
      }),
    );
    const setId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "O-Pee-Chee",
        parentId: sportId,
        platformData: {},
        children: [],
        lastUpdated: 1,
      }),
    );
    await seedBothJets(t, sportId);
    const cardId = await seedCard(t, setId, JETS);

    await t.mutation(internal.cardChecklist.backfillTeamToOnCardIds, {
      batchSize: 10,
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card?.teamOnCardIds ?? null).toBeNull();
    // The evidence an operator needs is kept — clearing it would destroy the
    // only record of what the marketplace claimed.
    expect(card?.team).toBe(JETS);
  });
});
