/**
 * NEO-203 — `teams.applyEnrichmentInternal` is GAP-FILL ONLY.
 *
 * Background enrichment (ESPN/Wikidata via `adapters/wikidata.ts`'s
 * `enrichTeam`) used to blindly restamp `city`, `yearsActive` and `colors` on
 * every enrichment pass — and a checklist commit enqueues one for every team
 * it touches (`commitCardChecklistFinalize` -> `wikidataPool.enqueueEnrichment`
 * -> `enrichTeam`), so a corrected city, a hand-entered franchise span, or
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
    city: string;
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
      city: "Boston",
      yearsActive: { from: 1908 },
      colors: { primary: "#0d2340", secondary: "#bd3039" },
    });

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      city: "Wrong City",
      yearsActive: { from: 1901, to: 1907 },
      colors: { primary: "#ffffff", secondary: "#000000" },
      league: "Major League Baseball",
    });

    const team = await getTeam(t, teamId);
    expect(team!.city).toBe("Boston");
    expect(team!.yearsActive).toEqual({ from: 1908 });
    expect(team!.colors).toEqual({ primary: "#0d2340", secondary: "#bd3039" });
  });

  test("a team with every field empty gets all of them filled", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedTeam(t);

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      city: "Boston",
      yearsActive: { from: 1908 },
      colors: { primary: "#0d2340", secondary: "#bd3039" },
    });

    const team = await getTeam(t, teamId);
    expect(team!.city).toBe("Boston");
    expect(team!.yearsActive).toEqual({ from: 1908 });
    expect(team!.colors).toEqual({ primary: "#0d2340", secondary: "#bd3039" });
  });

  test("fields are gap-filled INDEPENDENTLY — a populated city does not block empty colors from filling", async () => {
    const t = convexTest(schema, modules);
    // city is already set by a human; yearsActive and colors are gaps.
    const { teamId } = await seedTeam(t, { city: "Boston (operator-corrected)" });

    await t.mutation(internal.teams.applyEnrichmentInternal, {
      id: teamId,
      city: "Boston, Massachusetts", // a gap-filled value would clobber this
      yearsActive: { from: 1908 },
      colors: { primary: "#0d2340", secondary: "#bd3039" },
    });

    const team = await getTeam(t, teamId);
    // The populated field survives...
    expect(team!.city).toBe("Boston (operator-corrected)");
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
        city: "Boston",
      }),
    ).resolves.toBeNull();
  });
});
