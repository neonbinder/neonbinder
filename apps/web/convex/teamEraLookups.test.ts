/**
 * NEO-254 — the two callers that resolve a team NAME to a row and knew the
 * year but were not passing it.
 *
 * A sport can hold two teams under one name: the 1972-1996 Winnipeg Jets and
 * the 2011- Jets. `findByNameAndSport` answers `null` for several candidates by
 * design — a name alone is not an answer — so a caller that knows the year and
 * does not send it gets `null` forever, no matter how many times an operator
 * settles the question.
 *
 * Two such callers, each with a different right year:
 *
 *   - the review gate resolves a name off a SET, so its year is the set's;
 *   - a Wikidata career stint resolves a name off a SEASON the player actually
 *     played, so its year is the stint's start.
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

const ADMIN_IDENTITY = {
  subject: "admin_team_era_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_team_era_001",
  name: "Admin User",
  role: "admin",
};

async function seedSport(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

/** Both Winnipeg Jets — one name, two disjoint eras. */
async function seedBothJets(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) => {
    const mk = (from: number, to?: number) =>
      ctx.db.insert("teams", {
        location: "Winnipeg",
        name: "Jets",
        nameNormalized: normalizeTeamName("Winnipeg Jets"),
        sportId,
        yearsActive: { from, ...(to !== undefined ? { to } : {}) },
        lastUpdated: Date.now(),
      });
    return { original: await mk(1972, 1996), current: await mk(2011) };
  });
}

describe("NEO-254: findByNameAndSport needs the year the caller already has", () => {
  test("with no year, a two-era name is no answer at all", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedBothJets(t, sportId);

    expect(
      await t.withIdentity(ADMIN_IDENTITY).query(api.teams.findByNameAndSport, {
        name: "Winnipeg Jets",
        sportId,
      }),
    ).toBeNull();
  });

  test("the set's year picks the row whose era covers it", async () => {
    /*
     * This is what the review gate was missing. Without the year every
     * "Winnipeg Jets" was reported unknown and queued for review on EVERY sync
     * of the set — forever, however many times an operator answered it.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { original, current } = await seedBothJets(t, sportId);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    expect(
      (
        await asAdmin.query(api.teams.findByNameAndSport, {
          name: "Winnipeg Jets",
          sportId,
          setYear: 1985,
        })
      )?._id,
    ).toBe(original);
    expect(
      (
        await asAdmin.query(api.teams.findByNameAndSport, {
          name: "Winnipeg Jets",
          sportId,
          setYear: 2015,
        })
      )?._id,
    ).toBe(current);
  });

  test("a year no era covers is still no answer", async () => {
    // 1999: the first Jets had gone and the second had not arrived. Nothing to
    // link to, and guessing between two franchises is the failure being fixed.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedBothJets(t, sportId);

    expect(
      await t.withIdentity(ADMIN_IDENTITY).query(api.teams.findByNameAndSport, {
        name: "Winnipeg Jets",
        sportId,
        setYear: 1999,
      }),
    ).toBeNull();
  });
});

describe("NEO-254: the review gate passes the SET's year", () => {
  test("a two-era team name stops being reported unknown on every sync", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { original } = await seedBothJets(t, sportId);

    // sport → year → setName → variantType, so the gate can walk to 1985.
    const variantTypeId = await t.run(async (ctx) => {
      const yearId = await ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1985",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "O-Pee-Chee",
        platformData: {},
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      });
      const variantId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(setNameId, { children: [variantId] });
      await ctx.db.patch(yearId, { children: [setNameId] });
      await ctx.db.patch(sportId, { children: [yearId] });
      return variantId;
    });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.resolveChecklistEntities, {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          {
            cardNumber: "1",
            cardName: "Card",
            team: undefined,
            teams: ["Winnipeg Jets"],
            players: [],
            attributes: [],
            isRookie: false,
            isRelic: false,
            printRun: undefined,
            autographType: undefined,
            cardVariation: undefined,
            platformData: {},
            unmatched: undefined,
          },
        ],
      });

    // Resolved, not queued: the 1985 set means the 1972-1996 row.
    expect(result.unknownTeams).toEqual([]);
    expect(original).toBeTruthy();
  });
});

describe("NEO-254: a career stint resolves on the STINT's year", () => {
  test("a 1979 stint at a two-era club lands on the 1972 row", async () => {
    /*
     * Not the set's year — there is no set. This lookup is about a season the
     * player actually played, and in 1979 the only Winnipeg Jets were the
     * 1972-1996 ones; the 2011 franchise did not exist. Without the year the
     * name matched two rows, the lookup answered null, and the stint was
     * dropped from `teamYears` with a `career_team_unmatched` log.
     */
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { original } = await seedBothJets(t, sportId);

    expect(
      (
        await t.query(internal.teams.findByFullNameInternal, {
          name: "Winnipeg Jets",
          sportId,
          setYear: 1979,
        })
      ),
    ).toBe(original);
  });

  test("a 2014 stint at the same name lands on the 2011 row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { current } = await seedBothJets(t, sportId);

    expect(
      await t.query(internal.teams.findByFullNameInternal, {
        name: "Winnipeg Jets",
        sportId,
        setYear: 2014,
      }),
    ).toBe(current);
  });

  test("without a year it is still ambiguous, which is why the year is sent", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedBothJets(t, sportId);

    expect(
      await t.query(internal.teams.findByFullNameInternal, {
        name: "Winnipeg Jets",
        sportId,
      }),
    ).toBeNull();
  });
});
