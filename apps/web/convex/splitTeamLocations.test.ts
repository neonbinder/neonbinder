/**
 * NEO-236 — coverage for the one-shot `teams.name` → `location` + `name`
 * backfill.
 *
 * What these tests pin, and why each one earns its place:
 *
 *  - **unarmed refuses before anything happens.** There is no identity check
 *    anywhere under this entry point (a `convex run` carries none), so
 *    `ALLOW_SPLIT_TEAM_LOCATIONS` is the only thing between a call and a
 *    rewritten `teams` table. A refusal that had already patched a row or two
 *    would be worse than no gate at all, so the assertions are on the ROWS,
 *    not just on the throw — and on the ESPN mock never being called, because
 *    an unarmed run must not even reach out to a third party.
 *  - **the batch mutation refuses independently.** Same reasoning as NEO-214's
 *    reset (security review finding 7): the entry point is not the only door.
 *  - **a dry run reports exactly what a real run does, and writes nothing.**
 *    That output is what an operator reads before committing to production, so
 *    "the dry run lied" is the failure that matters most here.
 *  - **the dedup key never moves.** `normalizeTeamName` token-sorts, so
 *    splitting "San Diego Padres" into ("San Diego", "Padres") must leave
 *    `nameNormalized` byte-identical. If it ever does not, every card that
 *    resolves through that team quietly points at a second row.
 *  - **the four awkward real prefixes** — Tampa Bay, Golden State, Vegas, New
 *    England — because a naive "first token is the city" split gets every one
 *    of them wrong, and they are exactly what prod holds.
 *  - **the three refusals to guess**: a hand-written key, a row ESPN does not
 *    carry (colleges, NPB), and an ESPN location that is not a whole-word
 *    prefix of our name. Each is left whole and LISTED — Jason, 2026-09-05: no
 *    code path invents a location.
 *  - **idempotence**, because the runbook tells an operator to re-run after a
 *    partial failure.
 *
 * `fetchEspnTeamList` is mocked at the module boundary rather than by stubbing
 * `fetch`: this file targets what the task DOES with ESPN's answer, and
 * `convex/adapters/espn.test.ts` already owns the parsing of ESPN's payload.
 * Same `vi.mock` convention as `convex/bscTeamEnrichmentQueue.tolerance.test.ts`.
 *
 * Lives at the convex/ root like every other convex-test file here.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeEntityName } from "./lib/entityNearMatch";

/**
 * The mock's control surface, hoisted so the (hoisted) `vi.mock` factory below
 * can close over it. `lists` is keyed by ESPN league path; a path with no
 * entry, or an explicit `null`, is the "unmapped sport or failed fetch" case
 * the real adapter signals the same way.
 */
const espn = vi.hoisted(() => ({
  lists: new Map<
    string,
    Array<{ id?: string; displayName?: string; location?: string }> | null
  >(),
  calls: [] as string[],
}));

vi.mock("./adapters/espn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/espn")>();
  return {
    ...actual,
    fetchEspnTeamList: async (league?: { path: string }) => {
      if (!league) return null;
      espn.calls.push(league.path);
      return espn.lists.get(league.path) ?? null;
    },
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const NOW = 1_700_000_000_000;

const MLB = { path: "baseball/mlb", leagueName: "Major League Baseball" };
const NFL = { path: "football/nfl", leagueName: "National Football League" };

type TeamSeed = {
  /** The whole franchise name, as a pre-NEO-236 row holds it. */
  name: string;
  /** Present only when the row is already split. */
  location?: string;
  /**
   * Override the dedup key to simulate a hand-written / legacy one. Otherwise
   * derived the way every writer derives it.
   */
  nameNormalized?: string;
};

async function seed(
  t: ReturnType<typeof convexTest>,
  sports: Array<{
    value: string;
    espn?: { path: string; leagueName: string };
    teams: TeamSeed[];
  }>,
): Promise<Record<string, Id<"selectorOptions">>> {
  return t.run(async (ctx) => {
    const ids: Record<string, Id<"selectorOptions">> = {};
    for (const sport of sports) {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport" as const,
        value: sport.value,
        platformData: {},
        children: [],
        ...(sport.espn ? { sportConfig: { espn: sport.espn } } : {}),
        lastUpdated: NOW,
      });
      ids[sport.value] = sportId;
      for (const team of sport.teams) {
        await ctx.db.insert("teams", {
          name: team.name,
          nameNormalized:
            team.nameNormalized ??
            normalizeEntityName(
              team.location ? `${team.location} ${team.name}` : team.name,
            ),
          sportId,
          ...(team.location ? { location: team.location } : {}),
          lastUpdated: NOW,
        });
      }
    }
    return ids;
  });
}

async function allTeams(t: ReturnType<typeof convexTest>): Promise<Doc<"teams">[]> {
  const rows = await t.run(async (ctx) => ctx.db.query("teams").collect());
  return [...rows].sort((a, b) => a.nameNormalized.localeCompare(b.nameNormalized));
}

/** Just the fields this migration is allowed to touch. */
function identityOf(rows: Doc<"teams">[]) {
  return rows.map((r) => ({
    name: r.name,
    location: r.location,
    nameNormalized: r.nameNormalized,
  }));
}

function runSplit(t: ReturnType<typeof convexTest>, dryRun: boolean) {
  return t.action(internal.splitTeamLocations.run, { confirm: "SPLIT" as const, dryRun });
}

beforeEach(() => {
  espn.lists.clear();
  espn.calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("NEO-236 splitTeamLocations — arming", () => {
  test("unarmed: refuses, patches nothing, and never touches ESPN", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "San Diego Padres" }] },
    ]);
    espn.lists.set(MLB.path, [
      { displayName: "San Diego Padres", location: "San Diego" },
    ]);

    await expect(runSplit(t, false)).rejects.toThrow(/ALLOW_SPLIT_TEAM_LOCATIONS/);

    expect(identityOf(await allTeams(t))).toEqual([
      {
        name: "San Diego Padres",
        location: undefined,
        nameNormalized: "diego padres san",
      },
    ]);
    // The gate sits above the fetches, so an unarmed run costs nothing — not
    // even a request to a third party.
    expect(espn.calls).toEqual([]);
  });

  test("unarmed: a DRY run refuses too", async () => {
    // Deliberately one gate, not two. A dry run writes nothing but still walks
    // the table and hits ESPN, and "armed for writes, unarmed for reads" is the
    // kind of split rule that rots into a hole.
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "San Diego Padres" }] },
    ]);

    await expect(runSplit(t, true)).rejects.toThrow(/ALLOW_SPLIT_TEAM_LOCATIONS/);
  });

  test('a near-miss flag value ("1") is NOT armed', async () => {
    // The check is `!== "true"`. Arming is a deliberate act and a truthy-looking
    // value failing open would be the worst outcome.
    vi.stubEnv("ALLOW_SPLIT_TEAM_LOCATIONS", "1");
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "San Diego Padres" }] },
    ]);

    await expect(runSplit(t, false)).rejects.toThrow(/ALLOW_SPLIT_TEAM_LOCATIONS/);
  });

  test("applyBatch refuses when unarmed, even called directly", async () => {
    // The entry point is not the only door: anything already inside Convex can
    // call the batch. NEO-214 security review, finding 7 — same shape here.
    const t = convexTest(schema, modules);
    const ids = await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "San Diego Padres" }] },
    ]);

    await expect(
      t.mutation(internal.splitTeamLocations.applyBatch, {
        dryRun: false,
        cursor: null,
        espn: [
          {
            sportId: ids.Baseball,
            sport: "Baseball",
            teams: [
              { displayNameNormalized: "diego padres san", location: "San Diego" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/ALLOW_SPLIT_TEAM_LOCATIONS/);

    expect(identityOf(await allTeams(t))).toEqual([
      {
        name: "San Diego Padres",
        location: undefined,
        nameNormalized: "diego padres san",
      },
    ]);
  });
});

describe("NEO-236 splitTeamLocations — splitting from ESPN", () => {
  beforeEach(() => {
    vi.stubEnv("ALLOW_SPLIT_TEAM_LOCATIONS", "true");
  });

  test("San Diego Padres → Padres / San Diego, dedup key unchanged", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "San Diego Padres" }] },
    ]);
    espn.lists.set(MLB.path, [
      { displayName: "San Diego Padres", location: "San Diego" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts).toEqual({
      scanned: 1,
      split_espn: 1,
      skipped_already_split: 0,
      skipped_no_source: 0,
      skipped_not_prefix: 0,
      skipped_key_mismatch: 0,
    });
    expect(identityOf(await allTeams(t))).toEqual([
      {
        name: "Padres",
        location: "San Diego",
        // The whole point: token-sorted, so the split cannot move it.
        nameNormalized: "diego padres san",
      },
    ]);
    expect(result.espnLeagues).toEqual([{ sport: "Baseball", teams: 1 }]);
  });

  /**
   * The prefixes a "first token is the city" heuristic gets wrong. Every one of
   * these is a real prod row, and ESPN answers each correctly because its
   * `location` field IS the place part of its own display name.
   */
  test.each([
    ["Tampa Bay Buccaneers", "Tampa Bay", "Buccaneers"],
    ["Golden State Warriors", "Golden State", "Warriors"],
    ["Vegas Golden Knights", "Vegas", "Golden Knights"],
    ["New England Patriots", "New England", "Patriots"],
    ["St. Louis Blues", "St. Louis", "Blues"],
  ])("%s splits at %s", async (fullName, location, nickname) => {
    const t = convexTest(schema, modules);
    await seed(t, [{ value: "Football", espn: NFL, teams: [{ name: fullName }] }]);
    espn.lists.set(NFL.path, [{ displayName: fullName, location }]);
    const keyBefore = normalizeEntityName(fullName);

    const result = await runSplit(t, false);

    expect(result.counts.split_espn).toBe(1);
    expect(identityOf(await allTeams(t))).toEqual([
      { name: nickname, location, nameNormalized: keyBefore },
    ]);
  });

  test("matches ESPN by dedup key, so word order and punctuation cannot miss", async () => {
    // "Yankees, New York" is a real shape in marketplace payloads, and it is
    // why `nameNormalized` token-sorts in the first place. The row still finds
    // its ESPN entry — and then does NOT split, because "New York" is not a
    // prefix of that string. Matching and splitting are separate questions.
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "Yankees, New York" }] },
    ]);
    espn.lists.set(MLB.path, [
      { displayName: "New York Yankees", location: "New York" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.skipped_no_source).toBe(0);
    expect(result.counts.skipped_not_prefix).toBe(1);
    expect(result.notPrefix).toEqual([
      { name: "Yankees, New York", sport: "Baseball", espnLocation: "New York" },
    ]);
  });

  test("splits every league in one run, keyed per sport", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "San Diego Padres" }] },
      { value: "Football", espn: NFL, teams: [{ name: "Tampa Bay Buccaneers" }] },
    ]);
    espn.lists.set(MLB.path, [
      { displayName: "San Diego Padres", location: "San Diego" },
    ]);
    espn.lists.set(NFL.path, [
      { displayName: "Tampa Bay Buccaneers", location: "Tampa Bay" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.split_espn).toBe(2);
    expect(identityOf(await allTeams(t))).toEqual([
      {
        name: "Buccaneers",
        location: "Tampa Bay",
        nameNormalized: "bay buccaneers tampa",
      },
      { name: "Padres", location: "San Diego", nameNormalized: "diego padres san" },
    ]);
  });

  test("a sport's ESPN list is never applied to another sport's rows", async () => {
    // Football's list holds a team whose key matches a baseball row. Keying the
    // lookup on (sportId, key) is what stops the cross-sport bleed.
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "New York Giants" }] },
      { value: "Football", espn: NFL, teams: [] },
    ]);
    espn.lists.set(MLB.path, []);
    espn.lists.set(NFL.path, [
      { displayName: "New York Giants", location: "New York" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.split_espn).toBe(0);
    expect(result.counts.skipped_no_source).toBe(1);
    expect(result.noSource).toEqual([{ name: "New York Giants", sport: "Baseball" }]);
  });
});

describe("NEO-236 splitTeamLocations — the rows it refuses to touch", () => {
  beforeEach(() => {
    vi.stubEnv("ALLOW_SPLIT_TEAM_LOCATIONS", "true");
  });

  test("an already-split row is left exactly as it is", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      {
        value: "Baseball",
        espn: MLB,
        teams: [{ name: "Padres", location: "San Diego" }],
      },
    ]);
    // ESPN would happily answer for it; `location` is the stop sign.
    espn.lists.set(MLB.path, [
      { displayName: "San Diego Padres", location: "San Diego" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts).toEqual({
      scanned: 1,
      split_espn: 0,
      skipped_already_split: 1,
      skipped_no_source: 0,
      skipped_not_prefix: 0,
      skipped_key_mismatch: 0,
    });
    expect(identityOf(await allTeams(t))).toEqual([
      { name: "Padres", location: "San Diego", nameNormalized: "diego padres san" },
    ]);
  });

  test("a hand-written dedup key is never patched, and is reported", async () => {
    // The key disagrees with the row's own name — written by hand, or by
    // something older than `teamRowFields`. Re-deriving it here would silently
    // repoint every card that resolves through this team.
    const t = convexTest(schema, modules);
    await seed(t, [
      {
        value: "Baseball",
        espn: MLB,
        teams: [{ name: "San Diego Padres", nameNormalized: "padres sd" }],
      },
    ]);
    espn.lists.set(MLB.path, [
      { displayName: "San Diego Padres", location: "San Diego" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.skipped_key_mismatch).toBe(1);
    expect(result.counts.split_espn).toBe(0);
    expect(result.keyMismatch).toEqual(["San Diego Padres"]);
    expect(identityOf(await allTeams(t))).toEqual([
      {
        name: "San Diego Padres",
        location: undefined,
        nameNormalized: "padres sd",
      },
    ]);
  });

  test("a college side ESPN does not carry stays whole and is listed", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      {
        value: "Basketball",
        espn: MLB, // any mapped league; ESPN simply has no such team
        teams: [{ name: "San Diego State Aztecs men's basketball" }],
      },
    ]);
    espn.lists.set(MLB.path, [
      { displayName: "San Diego Padres", location: "San Diego" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.skipped_no_source).toBe(1);
    expect(result.noSource).toEqual([
      { name: "San Diego State Aztecs men's basketball", sport: "Basketball" },
    ]);
    // A mechanical prefix split WOULD have "worked" here — ESPN's "San Diego"
    // sits at the front of this name — and would have produced a location for a
    // college side that has none. The dedup-key match is what stops it.
    expect(identityOf(await allTeams(t))).toEqual([
      {
        name: "San Diego State Aztecs men's basketball",
        location: undefined,
        nameNormalized: normalizeEntityName("San Diego State Aztecs men's basketball"),
      },
    ]);
  });

  test("a sport with no ESPN config: every row is no-source, and it is visible", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      {
        value: "Baseball (NPB)",
        teams: [{ name: "Orix Buffaloes" }, { name: "Chunichi Dragons" }],
      },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.skipped_no_source).toBe(2);
    // `null`, not `0` — the operator has to be able to tell "no ESPN for this
    // sport" from "ESPN returned an empty list".
    expect(result.espnLeagues).toEqual([{ sport: "Baseball (NPB)", teams: null }]);
    expect(espn.calls).toEqual([]);
  });

  test("a failed ESPN fetch reports null rather than pretending there is no source", async () => {
    // The dangerous case: a four-second outage would otherwise look exactly
    // like "these 32 rows need hand splitting". `espnLeagues` is what turns it
    // back into a re-run.
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Football", espn: NFL, teams: [{ name: "Tampa Bay Buccaneers" }] },
    ]);
    espn.lists.set(NFL.path, null);

    const result = await runSplit(t, false);

    expect(result.espnLeagues).toEqual([{ sport: "Football", teams: null }]);
    expect(result.counts.skipped_no_source).toBe(1);
    expect(identityOf(await allTeams(t))).toEqual([
      {
        name: "Tampa Bay Buccaneers",
        location: undefined,
        nameNormalized: "bay buccaneers tampa",
      },
    ]);
  });

  test("an ESPN location that is not a whole-word prefix is refused, not forced", async () => {
    // ESPN says "Los Angeles"; our row reads "LA Angels". Splitting anyway
    // would invent a name nobody wrote.
    const t = convexTest(schema, modules);
    await seed(t, [{ value: "Baseball", espn: MLB, teams: [{ name: "LA Angels" }] }]);
    espn.lists.set(MLB.path, [
      { displayName: "LA Angels", location: "Los Angeles" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.skipped_not_prefix).toBe(1);
    expect(result.notPrefix).toEqual([
      { name: "LA Angels", sport: "Baseball", espnLocation: "Los Angeles" },
    ]);
    expect(identityOf(await allTeams(t))).toEqual([
      { name: "LA Angels", location: undefined, nameNormalized: "angels la" },
    ]);
  });

  test("punctuation that differs between our row and ESPN is refused, not forced", async () => {
    /**
     * The documented edge from the NEO-236 brief. Our row reads "St Louis
     * Blues"; ESPN spells the place "St. Louis". The two MATCH — both normalise
     * to "blues louis st", so the row finds its ESPN entry — but the split
     * still fails, because `splitTeamName` compares raw characters: "St Louis "
     * is not "st. louis".
     *
     * Left as `skipped_not_prefix` on purpose. Forcing it would mean choosing
     * whose punctuation wins, and writing ESPN's "St. Louis" onto a row whose
     * operator typed "St Louis" is a rename, not a split — the one thing this
     * task must never do silently. The row is listed with ESPN's answer beside
     * it, so the hand split on /admin/teams is one glance.
     */
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Hockey", espn: NFL, teams: [{ name: "St Louis Blues" }] },
    ]);
    espn.lists.set(NFL.path, [
      { displayName: "St. Louis Blues", location: "St. Louis" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.skipped_not_prefix).toBe(1);
    expect(result.counts.skipped_no_source).toBe(0);
    expect(result.notPrefix).toEqual([
      { name: "St Louis Blues", sport: "Hockey", espnLocation: "St. Louis" },
    ]);
    expect(identityOf(await allTeams(t))).toEqual([
      {
        name: "St Louis Blues",
        location: undefined,
        nameNormalized: "blues louis st",
      },
    ]);
  });

  test("two ESPN entries with the same key and different locations are dropped", async () => {
    // No answer to "where is this team" means no split. Picking one would be
    // exactly the guess this task refuses to make.
    const t = convexTest(schema, modules);
    await seed(t, [
      { value: "Baseball", espn: MLB, teams: [{ name: "New York Giants" }] },
    ]);
    espn.lists.set(MLB.path, [
      { displayName: "New York Giants", location: "New York" },
      { displayName: "Giants, New York", location: "San Francisco" },
    ]);

    const result = await runSplit(t, false);

    expect(result.counts.split_espn).toBe(0);
    expect(result.counts.skipped_no_source).toBe(1);
  });
});

describe("NEO-236 splitTeamLocations — dry run and idempotence", () => {
  beforeEach(() => {
    vi.stubEnv("ALLOW_SPLIT_TEAM_LOCATIONS", "true");
  });

  /** The mixed table both runs below are pointed at. */
  async function seedMixed(t: ReturnType<typeof convexTest>) {
    await seed(t, [
      {
        value: "Baseball",
        espn: MLB,
        teams: [
          { name: "San Diego Padres" },
          { name: "Tampa Bay Rays" },
          { name: "Padres", location: "San Diego" },
          { name: "LA Angels" },
          { name: "San Diego State Aztecs baseball" },
          { name: "New York Mets", nameNormalized: "mets ny" },
        ],
      },
    ]);
    espn.lists.set(MLB.path, [
      { displayName: "San Diego Padres", location: "San Diego" },
      { displayName: "Tampa Bay Rays", location: "Tampa Bay" },
      { displayName: "LA Angels", location: "Los Angeles" },
      { displayName: "New York Mets", location: "New York" },
    ]);
  }

  test("a dry run writes nothing and reports what the real run then does", async () => {
    const dry = convexTest(schema, modules);
    await seedMixed(dry);
    const before = identityOf(await allTeams(dry));

    const dryResult = await runSplit(dry, true);

    expect(dryResult.dryRun).toBe(true);
    expect(identityOf(await allTeams(dry))).toEqual(before);

    // Same table, same ESPN answers, for real this time.
    const real = convexTest(schema, modules);
    await seedMixed(real);
    const realResult = await runSplit(real, false);

    expect(realResult.dryRun).toBe(false);
    expect(realResult.counts).toEqual(dryResult.counts);
    expect(realResult.noSource).toEqual(dryResult.noSource);
    expect(realResult.notPrefix).toEqual(dryResult.notPrefix);
    expect(realResult.keyMismatch).toEqual(dryResult.keyMismatch);

    expect(dryResult.counts).toEqual({
      scanned: 6,
      split_espn: 2, // Padres, Rays
      skipped_already_split: 1, // the pre-split Padres row
      skipped_no_source: 1, // the college side
      skipped_not_prefix: 1, // LA Angels vs "Los Angeles"
      skipped_key_mismatch: 1, // the hand-written "mets ny"
    });
    // ...and the real run actually moved the two it said it would.
    expect(identityOf(await allTeams(real))).toContainEqual({
      name: "Rays",
      location: "Tampa Bay",
      nameNormalized: "bay rays tampa",
    });
  });

  test("a second run is a no-op: everything it split is already split", async () => {
    const t = convexTest(schema, modules);
    await seedMixed(t);

    await runSplit(t, false);
    const afterFirst = identityOf(await allTeams(t));

    const second = await runSplit(t, false);

    expect(second.counts).toEqual({
      scanned: 6,
      split_espn: 0,
      // The two it split now carry a location, plus the one that already did.
      skipped_already_split: 3,
      skipped_no_source: 1,
      skipped_not_prefix: 1,
      skipped_key_mismatch: 1,
    });
    expect(identityOf(await allTeams(t))).toEqual(afterFirst);
  });

  test("walks the whole table across more than one batch", async () => {
    // BATCH_SIZE is 50; 60 rows forces the cursor loop, which is the part that
    // would otherwise only ever be exercised in production.
    const t = convexTest(schema, modules);
    const teams = Array.from({ length: 60 }, (_, i) => ({
      name: `Springfield Isotopes${i}`,
    }));
    await seed(t, [{ value: "Baseball", espn: MLB, teams }]);
    espn.lists.set(
      MLB.path,
      teams.map((team) => ({ displayName: team.name, location: "Springfield" })),
    );

    const result = await runSplit(t, false);

    expect(result.counts.scanned).toBe(60);
    expect(result.counts.split_espn).toBe(60);
    const rows = await allTeams(t);
    expect(rows.every((r) => r.location === "Springfield")).toBe(true);
    expect(rows.every((r) => r.name.startsWith("Isotopes"))).toBe(true);
  });
});
