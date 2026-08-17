/**
 * NEO-156 — the release-time seeding of leagues and teams.
 *
 * This runs on every release, so the properties that matter are all about
 * running it AGAIN: it must converge rather than duplicate, and it must never
 * clobber a value a human or a live lookup has since produced.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };

/** Sport rows are created by the marketplace sync; seeding never invents one. */
async function seedSports(
  t: ReturnType<typeof convexTest>,
  values: string[],
): Promise<Record<string, Id<"selectorOptions">>> {
  return t.run(async (ctx) => {
    const out: Record<string, Id<"selectorOptions">> = {};
    for (const value of values) {
      out[value] = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value,
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
    }
    return out;
  });
}

const teams = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("teams").collect());
const leagues = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("leagues").collect());

const run = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity(ADMIN).action(api.seedTeamColors.seedFromBundledData, {});

describe("seedFromBundledData", () => {
  test("creates leagues and teams for the sports that exist", async () => {
    const t = convexTest(schema, modules);
    await seedSports(t, ["Baseball"]);

    const result = await run(t);

    // Only MLB's 30 land; the other five leagues' sports are not synced here.
    expect(result.teamsCreated).toBe(30);
    expect(result.total).toBe(165);
    expect(result.skippedNoSport).toBe(135);
    expect(await leagues(t)).toHaveLength(1);
    expect((await leagues(t))[0].abbreviation).toBe("MLB");
  });

  test("skips a league whose sport has never been synced", async () => {
    // The one failure mode that looks like success, which is why it is
    // reported rather than silently passed over.
    const t = convexTest(schema, modules);
    await seedSports(t, []);

    const result = await run(t);

    expect(result.teamsCreated).toBe(0);
    expect(result.skippedNoSport).toBe(165);
    expect(await leagues(t)).toHaveLength(0);
  });

  test("is idempotent — a second release creates nothing", async () => {
    const t = convexTest(schema, modules);
    await seedSports(t, ["Baseball", "Football"]);

    const first = await run(t);
    const afterFirst = (await teams(t)).length;
    const second = await run(t);

    expect(first.teamsCreated).toBeGreaterThan(0);
    expect(second.teamsCreated).toBe(0);
    expect((await teams(t)).length).toBe(afterFirst);
    // Leagues converge too — MLB and NFL, not two of each.
    expect(await leagues(t)).toHaveLength(2);
  });

  test("attaches colours and a league to the teams it creates", async () => {
    const t = convexTest(schema, modules);
    await seedSports(t, ["Baseball"]);

    await run(t);

    const brewers = (await teams(t)).find((x) => x.name === "Milwaukee Brewers");
    expect(brewers!.colors?.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(brewers!.leagueId).toBeDefined();
  });

  test("adopts an existing team rather than duplicating it", async () => {
    const t = convexTest(schema, modules);
    const sports = await seedSports(t, ["Baseball"]);
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        name: "Chicago Cubs",
        nameNormalized: normalizeTeamName("Chicago Cubs"),
        sportId: sports.Baseball,
        lastUpdated: 1_700_000_000_000,
      });
    });

    await run(t);

    const cubs = (await teams(t)).filter((x) => x.name === "Chicago Cubs");
    expect(cubs).toHaveLength(1);
    expect(cubs[0].colors?.primary).toBeDefined();
    expect(cubs[0].leagueId).toBeDefined();
  });

  test("NEVER overwrites colours that are already set", async () => {
    // An operator's hand-entered value, or one already resolved from the live
    // source, outranks this dataset — which is stale in places and carries no
    // recency we could compare against.
    const t = convexTest(schema, modules);
    const sports = await seedSports(t, ["Baseball"]);
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        name: "Chicago Cubs",
        nameNormalized: normalizeTeamName("Chicago Cubs"),
        sportId: sports.Baseball,
        colors: { primary: "#abcdef", secondary: "#123456" },
        lastUpdated: 1_700_000_000_000,
      });
    });

    await run(t);

    const cubs = (await teams(t)).find((x) => x.name === "Chicago Cubs");
    expect(cubs!.colors).toEqual({ primary: "#abcdef", secondary: "#123456" });
  });

  test("seeds a renamed franchise under its CURRENT name only", async () => {
    // The dataset says "Cleveland Indians". Seeding that verbatim beside our
    // "Cleveland Guardians" row would leave two rows for one franchise.
    const t = convexTest(schema, modules);
    await seedSports(t, ["Baseball"]);

    await run(t);

    const names = (await teams(t)).map((x) => x.name);
    expect(names).toContain("Cleveland Guardians");
    expect(names).not.toContain("Cleveland Indians");
    expect(names).toContain("Los Angeles Angels");
    expect(names).not.toContain("Los Angeles Angels of Anaheim");
  });

  test("does not duplicate a franchise we already hold under its current name", async () => {
    const t = convexTest(schema, modules);
    const sports = await seedSports(t, ["Baseball"]);
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        name: "Cleveland Guardians",
        nameNormalized: normalizeTeamName("Cleveland Guardians"),
        sportId: sports.Baseball,
        lastUpdated: 1_700_000_000_000,
      });
    });

    await run(t);

    const cleveland = (await teams(t)).filter((x) =>
      x.name.startsWith("Cleveland"),
    );
    expect(cleveland).toHaveLength(1);
    expect(cleveland[0].name).toBe("Cleveland Guardians");
  });

  test("seeds the NBA with colours too", async () => {
    // These 30 arrived empty in the original dataset and were filled from a
    // second source. Before that they seeded as colourless rows, which is the
    // one case where seeding produced a team the spine designer could not use.
    const t = convexTest(schema, modules);
    await seedSports(t, ["Basketball"]);

    const result = await run(t);

    expect(result.teamsCreated).toBe(30);
    expect(result.colorsApplied).toBe(30);
    const celtics = (await teams(t)).find((x) => x.name === "Boston Celtics");
    expect(celtics!.colors).toEqual({ primary: "#007a33", secondary: "#ba9653" });
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity({ subject: "u", role: "user" })
        .action(api.seedTeamColors.seedFromBundledData, {}),
    ).rejects.toThrow(/admin/i);
  });
});
