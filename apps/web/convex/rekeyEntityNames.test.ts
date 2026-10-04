/**
 * NEO-322 — the armed re-key of every stored copy of the entity-name key.
 *
 * What these tests pin, and why each earns its place:
 *
 *  - **nothing is written without BOTH arms.** The entry point carries no
 *    identity (a `convex run` has none), so the confirm phrase plus the
 *    deployment flag are the whole boundary. Every refusal is asserted on the
 *    ROWS (a full snapshot of all nine tables and the three side tables), not
 *    only on the throw or the report: a refusal that had already patched a row
 *    would be worse than no gate.
 *  - **`applyPage` refuses on its own.** The entry point is not the only door;
 *    the write mutation asserts the flag as its first statement.
 *  - **an armed run rewrites every table through the writers**, and a second
 *    run finds nothing left to do (the runbook's confirmation step).
 *  - **collision policy.** players/teams are written and reported; leagues and
 *    franchises are skipped and reported (their readers take `.first()`); a
 *    pre-existing duplicate that this run does not move is nobody's business.
 *  - **an incomplete plan writes nothing**, since its collision picture is
 *    partial.
 *
 * Fixtures write STALE keys straight into the tables, the way the pre-NEO-322
 * chain left them ("c j kayfus" where the current chain makes "cj kayfus").
 * `rekeyEntityNames.extraSport.test.ts` owns the playerSports collision
 * shapes; this file owns the arm and the apply.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  CONFIRM_PHRASE,
  ENV_FLAG,
  REPORT_LIST_CAP,
  SAMPLES_PER_TABLE,
} from "./rekeyEntityNames";
import type { RekeyRunReport } from "./rekeyEntityNames";
import { normalizeEntityName, normalizeOrderedEntityName } from "../lib/entities/normalize-name";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const NOW = 1_700_000_000_000;

beforeEach(() => {
  // The action logs a counts-only line per run; keep the output clean.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function arm() {
  vi.stubEnv(ENV_FLAG, "true");
}

async function insertSelector(t: T, level: "sport" | "setName", value: string): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: {},
      children: [],
      lastUpdated: NOW,
    }),
  );
}

type Ids = Awaited<ReturnType<typeof seedStale>>;

/**
 * One of everything, each carrying a hand-written stale key. No two rows share
 * a new key, so nothing here collides.
 */
async function seedStale(t: T) {
  const baseball = await insertSelector(t, "sport", "Baseball");
  const football = await insertSelector(t, "sport", "Football");
  const set = await insertSelector(t, "setName", "1996 Score");

  return t.run(async (ctx) => {
    const player = await ctx.db.insert("players", {
      name: "C. J. Kayfus",
      nameNormalized: "c j kayfus",
      sportId: baseball,
      aliases: ["C. J. K"],
      lastUpdated: NOW,
    });
    // Control: already current, must be left exactly as it is.
    const current = await ctx.db.insert("players", {
      name: "Mike Trout",
      nameNormalized: "mike trout",
      sportId: baseball,
      lastUpdated: NOW,
    });
    const membership = await ctx.db.insert("playerSports", {
      playerId: player,
      sportId: football,
      nameNormalized: "c j kayfus",
    });
    const playerAlias = await ctx.db.insert("playerAliases", {
      playerId: player,
      sportId: baseball,
      aliasNormalized: "c j k",
    });
    const team = await ctx.db.insert("teams", {
      location: "Texas A&M",
      name: "Aggies",
      nameNormalized: "a aggies m texas",
      sportId: baseball,
      aliases: ["A&M"],
      lastUpdated: NOW,
    });
    const teamAlias = await ctx.db.insert("teamAliases", {
      teamId: team,
      sportId: baseball,
      aliasNormalized: "a m",
    });
    const league = await ctx.db.insert("leagues", {
      name: "N. H. L.",
      nameNormalized: "n h l",
      sportId: baseball,
      lastUpdated: NOW,
    });
    const franchise = await ctx.db.insert("franchises", {
      name: "L. A. Dodgers",
      nameNormalized: "a dodgers l",
      sportId: baseball,
      lastUpdated: NOW,
    });
    const skip = await ctx.db.insert("entityReviewSkips", {
      selectorOptionId: set,
      kind: "player",
      name: "C. J. Kayfus",
      nameNormalized: "c j kayfus",
      skippedAt: NOW,
      skippedByUserId: "user_seed",
    });
    const queueBase = {
      selectorOptionId: set,
      batchId: "batch-1",
      createdByUserId: "user_seed",
      sportId: baseball,
      status: "ready" as const,
    };
    const queuePlayer = await ctx.db.insert("entityReviewQueue", {
      ...queueBase,
      kind: "player",
      name: "C. J. Kayfus",
      nameNormalized: "c j kayfus",
    });
    const queueTeam = await ctx.db.insert("entityReviewQueue", {
      ...queueBase,
      kind: "team",
      name: "Texas A&M Aggies",
      nameNormalized: "a aggies m texas",
    });
    const queueLeague = await ctx.db.insert("entityReviewQueue", {
      ...queueBase,
      kind: "league",
      name: "N. H. L.",
      nameNormalized: "n h l",
    });
    return {
      baseball,
      football,
      set,
      player,
      current,
      membership,
      playerAlias,
      team,
      teamAlias,
      league,
      franchise,
      skip,
      queuePlayer,
      queueTeam,
      queueLeague,
    };
  });
}

const ALL_TABLES = [
  "players",
  "playerSports",
  "playerAliases",
  "teams",
  "teamAliases",
  "leagues",
  "franchises",
  "entityReviewSkips",
  "entityReviewQueue",
] as const;

/** Every row of every table the re-key may touch, as plain JSON. */
async function snapshot(t: T): Promise<Record<string, unknown[]>> {
  return t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of ALL_TABLES) out[table] = await ctx.db.query(table).collect();
    return out;
  });
}

async function dryRun(t: T, args: { pageSize?: number; maxPages?: number } = {}): Promise<RekeyRunReport> {
  return (await t.action(internal.rekeyEntityNames.run, args)) as RekeyRunReport;
}

async function armedRun(t: T, args: { pageSize?: number; maxPages?: number } = {}): Promise<RekeyRunReport> {
  return (await t.action(internal.rekeyEntityNames.run, {
    confirm: CONFIRM_PHRASE,
    ...args,
  })) as RekeyRunReport;
}

function toRekey(report: RekeyRunReport, table: (typeof ALL_TABLES)[number]): number {
  return report.tables.find((r) => r.table === table)!.toRekey;
}

async function thrown(p: Promise<unknown>): Promise<ConvexError<{ code: string; message: string; report?: RekeyRunReport }>> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConvexError);
    return e as ConvexError<{ code: string; message: string; report?: RekeyRunReport }>;
  }
  throw new Error("expected the call to throw");
}

describe("rekeyEntityNames: a call without both arms writes nothing", () => {
  test("a dry run, even on an armed deployment, reports the plan and writes nothing", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedStale(t);
    const before = await snapshot(t);

    const report = await dryRun(t);

    expect(report.mode).toBe("dry_run");
    expect(report.armed).toBe(false);
    expect(report.isComplete).toBe(true);
    for (const table of ALL_TABLES) expect(toRekey(report, table)).toBe(table === "entityReviewQueue" ? 3 : 1);
    expect(report.tables.every((r) => r.applied === 0)).toBe(true);
    expect(report.collisionCount).toBe(0);
    expect(report.samples).toContainEqual(
      expect.objectContaining({ table: "players", name: "C. J. Kayfus", oldKey: "c j kayfus", newKey: "cj kayfus" }),
    );
    expect(await snapshot(t)).toEqual(before);
  });

  test("a misspelled confirm is a dry run that says so, and writes nothing", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedStale(t);
    const before = await snapshot(t);

    const report = (await t.action(internal.rekeyEntityNames.run, {
      confirm: "rekey entity names",
    })) as RekeyRunReport;

    expect(report.mode).toBe("dry_run");
    expect(report.armed).toBe(false);
    expect(report.message).toContain("not exactly");
    expect(toRekey(report, "players")).toBe(1);
    expect(await snapshot(t)).toEqual(before);
  });

  test.each([
    ["the flag is unset", undefined],
    ['the flag is "1" (only the literal "true" arms)', "1"],
  ])("a confirmed run is refused with REKEY_NOT_ARMED and the report when %s", async (_label, flag) => {
    if (flag !== undefined) vi.stubEnv(ENV_FLAG, flag);
    const t = convexTest(schema, modules);
    await seedStale(t);
    const before = await snapshot(t);

    const err = await thrown(armedRun(t));

    expect(err.data.code).toBe("REKEY_NOT_ARMED");
    expect(err.data.message).toContain(ENV_FLAG);
    expect(err.data.report?.mode).toBe("dry_run");
    expect(err.data.report?.armed).toBe(false);
    expect(toRekey(err.data.report!, "players")).toBe(1);
    expect(await snapshot(t)).toEqual(before);
  });

  test("applyPage refuses on an unarmed deployment even when called directly", async () => {
    const t = convexTest(schema, modules);
    await seedStale(t);
    const before = await snapshot(t);

    const err = await thrown(
      t.mutation(internal.rekeyEntityNames.applyPage, {
        table: "players",
        cursor: null,
        confirm: CONFIRM_PHRASE,
      }),
    );

    expect(err.data.code).toBe("REKEY_NOT_ARMED");
    expect(await snapshot(t)).toEqual(before);
  });
});

describe("rekeyEntityNames: an armed run", () => {
  test("rewrites every table and side table to the current key and leaves names alone", async () => {
    arm();
    const t = convexTest(schema, modules);
    const ids: Ids = await seedStale(t);

    const report = await armedRun(t);

    expect(report.mode).toBe("applied");
    expect(report.armed).toBe(true);
    expect(report.isComplete).toBe(true);
    expect(report.collisionCount).toBe(0);
    expect(report.refusedCount).toBe(0);
    expect(report.tables.find((r) => r.table === "players")!.applied).toBe(1);
    expect(report.tables.find((r) => r.table === "teams")!.applied).toBe(1);
    expect(report.tables.find((r) => r.table === "entityReviewQueue")!.applied).toBe(3);

    await t.run(async (ctx) => {
      const player = (await ctx.db.get(ids.player))!;
      expect(player.nameNormalized).toBe("cj kayfus");
      // A re-key is not an edit: name, aliases and lastUpdated are untouched.
      expect(player.name).toBe("C. J. Kayfus");
      expect(player.aliases).toEqual(["C. J. K"]);
      expect(player.lastUpdated).toBe(NOW);
      expect((await ctx.db.get(ids.current))!.nameNormalized).toBe("mike trout");

      // Side tables go through their writers: the stale copy is gone, the
      // current one exists for every sport the player belongs to.
      const memberships = await ctx.db.query("playerSports").collect();
      expect(memberships.map((m) => [m.playerId, m.sportId, m.nameNormalized])).toEqual([
        [ids.player, ids.football, "cj kayfus"],
      ]);
      const aliases = await ctx.db.query("playerAliases").collect();
      expect(aliases.map((a) => a.aliasNormalized).sort()).toEqual(["cjk", "cjk"]);
      expect(aliases.map((a) => a.sportId).sort()).toEqual([ids.baseball, ids.football].sort());

      const team = (await ctx.db.get(ids.team))!;
      expect(team.nameNormalized).toBe("aggies am texas");
      expect(team.name).toBe("Aggies");
      expect(team.location).toBe("Texas A&M");
      const teamAliases = await ctx.db.query("teamAliases").collect();
      expect(teamAliases.map((a) => [a.teamId, a.aliasNormalized])).toEqual([[ids.team, "am"]]);

      expect((await ctx.db.get(ids.league))!.nameNormalized).toBe("nhl");
      expect((await ctx.db.get(ids.franchise))!.nameNormalized).toBe("dodgers la");
      expect((await ctx.db.get(ids.skip))!.nameNormalized).toBe("cj kayfus");
      expect((await ctx.db.get(ids.queuePlayer))!.nameNormalized).toBe("cj kayfus");
      expect((await ctx.db.get(ids.queueTeam))!.nameNormalized).toBe("aggies am texas");
      // The league-kind queue row takes the ORDERED key, like startBatch.
      expect((await ctx.db.get(ids.queueLeague))!.nameNormalized).toBe("nhl");
    });
  });

  test("a second run reports toRekey 0 in every table and writes nothing", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedStale(t);
    await armedRun(t);
    const after = await snapshot(t);

    const again = await armedRun(t);

    expect(again.tables.every((r) => r.toRekey === 0 && r.applied === 0)).toBe(true);
    expect(again.collisionCount).toBe(0);
    expect(await snapshot(t)).toEqual(after);
  });

  test("two players landing on one key are both written and reported as one group", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sport = await insertSelector(t, "sport", "Baseball");
    const [a, b] = await t.run(async (ctx) => [
      await ctx.db.insert("players", {
        name: "C. J. Kayfus",
        nameNormalized: "c j kayfus",
        sportId: sport,
        lastUpdated: NOW,
      }),
      await ctx.db.insert("players", {
        name: "C J Kayfus",
        nameNormalized: "c j kayfus",
        sportId: sport,
        lastUpdated: NOW,
      }),
    ]);

    const report = await armedRun(t);

    expect(report.collisionCount).toBe(1);
    expect(report.collisions[0]).toMatchObject({
      table: "players",
      scope: "Baseball",
      key: "cj kayfus",
      policy: "written",
    });
    expect(report.collisions[0].members.map((m) => m.id).sort()).toEqual([a, b].sort());
    await t.run(async (ctx) => {
      expect((await ctx.db.get(a))!.nameNormalized).toBe("cj kayfus");
      expect((await ctx.db.get(b))!.nameNormalized).toBe("cj kayfus");
    });
  });

  test("two changed leagues landing on one key both stay on the old key and are reported as skipped", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sport = await insertSelector(t, "sport", "Hockey");
    const [a, b] = await t.run(async (ctx) => [
      await ctx.db.insert("leagues", { name: "N. H. L.", nameNormalized: "n h l", sportId: sport, lastUpdated: NOW }),
      await ctx.db.insert("leagues", { name: "N H L", nameNormalized: "n h l", sportId: sport, lastUpdated: NOW }),
    ]);

    const report = await armedRun(t);

    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]).toMatchObject({ table: "leagues", key: "nhl", policy: "skipped" });
    const row = report.tables.find((r) => r.table === "leagues")!;
    expect(row.skippedCollision).toBe(2);
    expect(row.toRekey).toBe(0);
    expect(row.applied).toBe(0);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(a))!.nameNormalized).toBe("n h l");
      expect((await ctx.db.get(b))!.nameNormalized).toBe("n h l");
    });
  });

  test("two changed franchises landing on one key both stay on the old key and are reported as skipped", async () => {
    arm();
    const t = convexTest(schema, modules);
    const sport = await insertSelector(t, "sport", "Baseball");
    const [a, b] = await t.run(async (ctx) => [
      await ctx.db.insert("franchises", { name: "L. A. Dodgers", nameNormalized: "a dodgers l", sportId: sport, lastUpdated: NOW }),
      await ctx.db.insert("franchises", { name: "L.A. Dodgers", nameNormalized: "a dodgers l", sportId: sport, lastUpdated: NOW }),
    ]);

    const report = await armedRun(t);

    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]).toMatchObject({ table: "franchises", key: "dodgers la", policy: "skipped" });
    const row = report.tables.find((r) => r.table === "franchises")!;
    expect(row.skippedCollision).toBe(2);
    expect(row.applied).toBe(0);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(a))!.nameNormalized).toBe("a dodgers l");
      expect((await ctx.db.get(b))!.nameNormalized).toBe("a dodgers l");
    });
  });

  test("a duplicate that already shared a stable key is not reported", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedStale(t);
    const sport = await insertSelector(t, "sport", "Basketball");
    await t.run(async (ctx) => {
      for (const name of ["Pacific Coast League", "Pacific Coast League"]) {
        await ctx.db.insert("leagues", {
          name,
          nameNormalized: normalizeOrderedEntityName(name),
          sportId: sport,
          lastUpdated: NOW,
        });
      }
      for (const name of ["Mike Trout", "Mike Trout"]) {
        await ctx.db.insert("players", {
          name,
          nameNormalized: normalizeEntityName(name),
          sportId: sport,
          lastUpdated: NOW,
        });
      }
    });

    const report = await armedRun(t);

    expect(report.collisionCount).toBe(0);
    expect(report.collisions).toEqual([]);
  });

  test("an incomplete plan writes nothing, even armed and confirmed", async () => {
    arm();
    const t = convexTest(schema, modules);
    await seedStale(t);
    const before = await snapshot(t);

    const report = await armedRun(t, { pageSize: 1, maxPages: 1 });

    expect(report.mode).toBe("dry_run");
    expect(report.armed).toBe(false);
    expect(report.isComplete).toBe(false);
    expect(report.message).toContain("maxPages");
    expect(report.tables.every((r) => r.applied === 0)).toBe(true);
    expect(await snapshot(t)).toEqual(before);
  });
});

describe("rekeyEntityNames: report lists are capped, counts stay exact", () => {
  test(`samples keep at most ${SAMPLES_PER_TABLE} per table while toRekey counts every row`, async () => {
    const t = convexTest(schema, modules);
    const sport = await insertSelector(t, "sport", "Baseball");
    const total = SAMPLES_PER_TABLE + 5;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i += 1) {
        await ctx.db.insert("franchises", {
          name: `Club${i} A. B.`,
          nameNormalized: `a b club${i}`,
          sportId: sport,
          lastUpdated: NOW,
        });
      }
    });

    const report = await dryRun(t);

    expect(toRekey(report, "franchises")).toBe(total);
    expect(report.samples.filter((s) => s.table === "franchises")).toHaveLength(SAMPLES_PER_TABLE);
  });

  test(`collision groups are listed up to ${REPORT_LIST_CAP} while collisionCount is exact`, async () => {
    const t = convexTest(schema, modules);
    const sport = await insertSelector(t, "sport", "Baseball");
    const groups = REPORT_LIST_CAP + 1;
    await t.run(async (ctx) => {
      for (let i = 0; i < groups; i += 1) {
        for (const name of [`Club${i} A. B.`, `Club${i} A.B.`]) {
          await ctx.db.insert("franchises", {
            name,
            nameNormalized: `a b club${i}`,
            sportId: sport,
            lastUpdated: NOW,
          });
        }
      }
    });

    const report = await dryRun(t);

    expect(report.collisionCount).toBe(groups);
    expect(report.collisions).toHaveLength(REPORT_LIST_CAP);
  });
});
