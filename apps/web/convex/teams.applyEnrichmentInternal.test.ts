/**
 * NEO-203 — `teams.applyEnrichmentInternal` is GAP-FILL ONLY.
 *
 * Background enrichment (ESPN/Wikidata via `adapters/wikidata.ts`'s
 * `enrichTeam`) used to blindly restamp `location`, `yearsActive` and `colors` on
 * every enrichment pass — and a checklist commit enqueues one for every team
 * it touches (`commitCardChecklistFinalize` -> `wikidataPool.enqueueEnrichment`
 * -> `enrichTeam`), so a corrected location, a hand-entered franchise span, or
 * hand-picked spine-label colors survived only until the next sync. `leagueId`
 * already followed the gap-fill rule (only assigned when absent); NEO-203
 * applied the same rule to the other three fields it did not yet cover.
 *
 * These tests call `applyEnrichmentInternal` directly rather than the network-
 * backed `enrichTeam` (already covered end-to-end in
 * convex/wikidataEnrichTeam.test.ts) — the gap-fill rule lives entirely in
 * this one mutation, so exercising it directly needs no ESPN/Wikidata mocking.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

async function seedTeam(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    location: string;
    yearsActive: { from: number; to?: number };
    colors: { primary?: string; secondary?: string };
  }> = {},
): Promise<{ sportId: Id<"selectorOptions">; teamId: Id<"teams"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    });
    const teamId = await ctx.db.insert("teams", {
      name: "Boston Red Sox",
      nameNormalized: normalizeTeamName("Boston Red Sox"),
      sportId,
      lastUpdated: 1_700_000_000_000,
      ...overrides,
    });
    return { sportId, teamId };
  });
}

const getTeam = (t: ReturnType<typeof convexTest>, id: Id<"teams">) =>
  t.run(async (ctx) => ctx.db.get(id));

describe("teams.applyEnrichmentInternal — gap-fill only (NEO-203)", () => {
  test("a team with every field already populated is left completely untouched", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedTeam(t, {
      location: "Boston",
      yearsActive: { from: 1908 },
      colors: { primary: "#0d2340", secondary: "#bd3039" },
    });

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      location: "Wrong Location",
      yearsActive: { from: 1901, to: 1907 },
      colors: { primary: "#ffffff", secondary: "#000000" },
      league: "Major League Baseball",
    });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBe("Boston");
    expect(team!.yearsActive).toEqual({ from: 1908 });
    expect(team!.colors).toEqual({ primary: "#0d2340", secondary: "#bd3039" });
  });

  test("a team with every field empty gets all of them filled", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedTeam(t);

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      location: "Boston",
      yearsActive: { from: 1908 },
      colors: { primary: "#0d2340", secondary: "#bd3039" },
    });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBe("Boston");
    // NEO-236: `location` does not sit alongside the whole name, it is SPLIT
    // out of it — the row was created as "Boston Red Sox" by a path with no
    // location to pass, and ESPN's answer says which words those are.
    expect(team!.name).toBe("Red Sox");
    expect(team!.nameNormalized).toBe(normalizeTeamName("Boston Red Sox"));
    expect(team!.yearsActive).toEqual({ from: 1908 });
    expect(team!.colors).toEqual({ primary: "#0d2340", secondary: "#bd3039" });
  });

  test("fields are gap-filled INDEPENDENTLY — a populated location does not block empty colors from filling", async () => {
    const t = convexTest(schema, modules);
    // location is already set by a human; yearsActive and colors are gaps.
    const { teamId } = await seedTeam(t, { location: "Boston (operator-corrected)" });

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      location: "Boston, Massachusetts", // a gap-filled value would clobber this
      yearsActive: { from: 1908 },
      colors: { primary: "#0d2340", secondary: "#bd3039" },
    });

    const team = await getTeam(t, teamId);
    // The populated field survives — and so, therefore, does the name.
    expect(team!.location).toBe("Boston (operator-corrected)");
    expect(team!.name).toBe("Boston Red Sox");
    // ...while the genuinely empty ones were filled.
    expect(team!.yearsActive).toEqual({ from: 1908 });
    expect(team!.colors).toEqual({ primary: "#0d2340", secondary: "#bd3039" });
  });

  test("colors with only ONE swatch already set still counts as populated — the other half is not silently filled", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedTeam(t, { colors: { primary: "#0d2340" } });

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      colors: { primary: "#ffffff", secondary: "#000000" },
    });

    const team = await getTeam(t, teamId);
    // `applyEnrichmentInternal` gates on `!existing.colors?.primary &&
    // !existing.colors?.secondary` — either half present means "populated".
    expect(team!.colors).toEqual({ primary: "#0d2340" });
  });

  test("a missing target row is a no-op, not an error", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedTeam(t);
    await t.run(async (ctx) => ctx.db.delete(teamId));

    await expect(
      t.mutation(internal.teams.applyEnrichmentInternal, {
        id: teamId,
        location: "Boston",
      }),
    ).resolves.toBeNull();
  });
});

/**
 * NEO-236 — the location gap-fill is a SPLIT of the name the row already has,
 * and the guards on it are the guards on "never rewrite a name a human wrote".
 */
describe("teams.applyEnrichmentInternal — the location split (NEO-236)", () => {
  test("a location that is not a whole-word prefix writes nothing at all", async () => {
    const t = convexTest(schema, modules);
    // The real case: ESPN answers "Anaheim" for the Los Angeles Angels. True
    // about the club, false as an answer to "what is the front of this name".
    const { teamId } = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
      const teamId = await ctx.db.insert("teams", {
        name: "Los Angeles Angels",
        nameNormalized: normalizeTeamName("Los Angeles Angels"),
        sportId,
        lastUpdated: 1_700_000_000_000,
      });
      return { teamId };
    });

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      location: "Anaheim",
    });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBeUndefined();
    expect(team!.name).toBe("Los Angeles Angels");
  });

  test("a location EQUAL to the whole name writes nothing — there would be no nickname left", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedTeam(t);

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      location: "Boston Red Sox",
    });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBeUndefined();
    expect(team!.name).toBe("Boston Red Sox");
  });

  /**
   * NEO-236 security review — ESPN decides WHERE to cut, never how the pieces
   * are spelled.
   *
   * `splitTeamName` returns a slice of the name we already hold, so a source
   * with a different house style cannot re-case or re-punctuate a name an
   * operator typed. Pinned end-to-end here (not just on the pure helper)
   * because this mutation writes both halves straight back onto the row.
   */
  test("ESPN's casing does not re-case our stored name", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
      const teamId = await ctx.db.insert("teams", {
        name: "SAN DIEGO PADRES",
        nameNormalized: normalizeTeamName("SAN DIEGO PADRES"),
        sportId,
        lastUpdated: 1_700_000_000_000,
      });
      return { teamId };
    });

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      location: "san diego",
    });

    const team = await getTeam(t, teamId);
    // OUR spelling on both halves, not ESPN's.
    expect(team!.location).toBe("SAN DIEGO");
    expect(team!.name).toBe("PADRES");
  });

  /**
   * The punctuation twin, and it refuses outright.
   *
   * ESPN writes "St. Louis"; our row says "St Louis Blues". The strict split
   * is character-exact apart from case, so the period is a miss and NOTHING is
   * written — the row keeps "St Louis" and does not acquire a re-punctuated
   * "St. Louis". Refusing is the right answer for a background writer: the
   * operator-run migration has a word-boundary equivalence fallback for
   * exactly this pair (and it, too, returns our spelling), and that looser
   * match stays behind a human who reads its report.
   */
  test("an ESPN location differing only in punctuation writes nothing — no re-punctuated name", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Hockey",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
      const teamId = await ctx.db.insert("teams", {
        name: "St Louis Blues",
        nameNormalized: normalizeTeamName("St Louis Blues"),
        sportId,
        lastUpdated: 1_700_000_000_000,
      });
      return { teamId };
    });

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      location: "St. Louis",
    });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBeUndefined();
    expect(team!.name).toBe("St Louis Blues");
  });

  test("a partial-word prefix does not split — 'Bost' is not a location", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedTeam(t);

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      location: "Bost",
    });

    const team = await getTeam(t, teamId);
    expect(team!.location).toBeUndefined();
    expect(team!.name).toBe("Boston Red Sox");
  });

  /**
   * The structural belt. The recomputed key is identical BY CONSTRUCTION
   * (`normalizeTeamName` token-sorts, so moving a leading word cannot change
   * it), so a mismatch can only mean the row's stored key was not derived from
   * its name — hand-written, or written by something that bypassed
   * `teamRowFields`. Patching such a row would strand it: every identity
   * lookup would stop finding it. It refuses instead.
   */
  test("a row whose stored key does not match its name is REFUSED, not silently repaired", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
      const teamId = await ctx.db.insert("teams", {
        name: "Boston Red Sox",
        // Hand-written and wrong for the name beside it.
        nameNormalized: "something else entirely",
        sportId,
        lastUpdated: 1_700_000_000_000,
      });
      return { teamId };
    });

    await expect(
      t.mutation(internal.teams.applyEnrichmentInternal, {
        id: teamId,
        location: "Boston",
      }),
    ).rejects.toThrow(/dedup key/);

    const team = await getTeam(t, teamId);
    expect(team!.name).toBe("Boston Red Sox");
    expect(team!.nameNormalized).toBe("something else entirely");
    expect(team!.location).toBeUndefined();
  });
});
