/**
 * NEO-147 — the E2E fixture contract.
 *
 * `seedTestTeams` is what makes the spine designer and Team Management
 * testable at all. After a reset the teams and players tables are EMPTY, so a
 * flow can only assert on data this mutation puts there — which is why the two
 * surfaces that read colours and career teams originally shipped with no E2E
 * coverage.
 *
 * These cases lock the fixture's shape. A flow asserting "New York Yankees" in
 * navy is only meaningful while that is still what gets seeded, and a change
 * here should break these rather than a Maestro run twenty minutes later.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi, afterEach } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedBaseballSport(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
      },
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

const run = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity(ADMIN).mutation(api.teams.seedTestTeams, {});

const teams = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("teams").collect());
const players = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("players").collect());

describe("seedTestTeams", () => {
  test("seeds both teams WITH colours", async () => {
    // The colours are the point. Team Management's detail panel, the spine
    // designer's team picker and the contrast readout all read them, and after
    // a reset nothing else in the database has any.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await seedBaseballSport(t);

    const result = await run(t);

    expect(result.created).toBe(2);
    const byName = new Map((await teams(t)).map((x) => [x.name, x]));
    expect(byName.get("New York Yankees")!.colors).toEqual({
      primary: "#132448",
      secondary: "#c4ced3",
    });
    expect(byName.get("New York Mets")!.colors?.primary).toBe("#002d72");
  });

  test("seeds a fixture player with TWO stints of different length", async () => {
    // A single-team fixture would pass whatever the longest-tenure logic did.
    // Ten Yankees years against two Mets years gives it something to be right
    // or wrong about.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await seedBaseballSport(t);

    const result = await run(t);

    expect(result.playersCreated).toBe(1);
    const player = (await players(t))[0];
    expect(player.name).toBe("E2E Fixture Player");
    expect(player.teamYears).toHaveLength(2);

    const byId = new Map((await teams(t)).map((x) => [x._id as string, x]));
    const [first, second] = player.teamYears!;
    expect(byId.get(first.teamId)!.name).toBe("New York Yankees");
    expect(first.toYear! - first.fromYear).toBeGreaterThan(
      second.toYear! - second.fromYear,
    );
  });

  test("the longest stint is the one with colours a flow can assert on", async () => {
    // Ties the fixture to what the spine designer will actually render: pick
    // the fixture player and the label should come up in Yankees navy.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await seedBaseballSport(t);
    await run(t);

    const player = (await players(t))[0];
    const longest = player.teamYears!.reduce((a, b) =>
      (b.toYear! - b.fromYear) > (a.toYear! - a.fromYear) ? b : a,
    );
    const team = await t.run(async (ctx) => ctx.db.get(longest.teamId));
    expect(team!.name).toBe("New York Yankees");
    expect(team!.colors?.primary).toBe("#132448");
  });

  test("REPAIRS colours on a team that already exists", async () => {
    // The case a fresh-reset CI run never hits, and every other deployment
    // does: the row exists from a marketplace sync or the bundled colour
    // dataset, carrying colours the flows do not assert on. A fixture that
    // skipped it would quietly mean something different there.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    const sportId = await seedBaseballSport(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        name: "New York Yankees",
        // Via the real normalizer, not by hand: it token-SORTS, so this key is
        // "new yankees york". Writing the obvious string instead produced a row
        // the fixture could not find, and the test caught it.
        nameNormalized: normalizeTeamName("New York Yankees"),
        sportId,
        colors: { primary: "#abcdef", secondary: "#123456" },
        lastUpdated: 1_700_000_000_000,
      });
    });

    const result = await run(t);

    expect(result.existing).toBe(1);
    const yankees = (await teams(t)).find((x) => x.name === "New York Yankees");
    expect(yankees!.colors).toEqual({
      primary: "#132448",
      secondary: "#c4ced3",
    });
  });

  test("is idempotent — a re-run creates nothing", async () => {
    // setup.yaml taps this on every run, and the E2E queue shares one
    // deployment across eight runners.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await seedBaseballSport(t);

    await run(t);
    const second = await run(t);

    expect(second.created).toBe(0);
    expect(second.existing).toBe(2);
    expect(second.playersCreated).toBe(0);
    expect(await teams(t)).toHaveLength(2);
    expect(await players(t)).toHaveLength(1);
  });

  test("refuses without the environment gate", async () => {
    // Same blast radius as the reset: this writes globally-shared rows.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "");
    const t = convexTest(schema, modules);
    await seedBaseballSport(t);
    await expect(run(t)).rejects.toThrow(/not enabled/i);
  });

  test("fails loudly when the sport row is missing", async () => {
    // NEO-96 ordering: teams reference the sport ROW, so the sync has to have
    // run first. Silently seeding nothing would surface as a confusing failure
    // far downstream.
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await expect(run(t)).rejects.toThrow(/sport sync first/i);
  });

  test("requires admin", async () => {
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const t = convexTest(schema, modules);
    await seedBaseballSport(t);
    await expect(
      t
        .withIdentity({ subject: "u", role: "user" })
        .mutation(api.teams.seedTestTeams, {}),
    ).rejects.toThrow(/admin/i);
  });
});
