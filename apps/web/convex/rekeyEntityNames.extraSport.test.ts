/**
 * NEO-322 — the re-key's collision report covers a player's EXTRA sports.
 *
 * A player re-keyed at home also re-keys every `playerSports` row (the writer
 * copies the new key onto them). Those rows are the player's identity in
 * another sport, so a clash there is a clash: reported under `players`, policy
 * "written" (report, never merge), in the same group as that sport's home
 * rows. And the converse: a player re-keyed at home meeting another player
 * who belongs to that sport only through a membership row.
 *
 * Fixtures write stale keys straight into the tables, the way an older chain
 * left them ("c j kayfus" where the current chain makes "cj kayfus").
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeEntityName } from "../lib/entities/normalize-name";
import type { RekeyRunReport } from "./rekeyEntityNames";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const OLD_KEY = "c j kayfus";
const NEW_KEY = "cj kayfus";

async function seedSport(t: T, value: string): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

/** A player row with an explicit stored key (stale or current). */
async function insertPlayer(
  t: T,
  opts: { name: string; sportId: Id<"selectorOptions">; nameNormalized: string },
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name: opts.name,
      nameNormalized: opts.nameNormalized,
      sportId: opts.sportId,
      createdByUserId: "user_seed",
      lastUpdated: Date.now(),
    }),
  );
}

/** A membership row carrying whatever copy of the key the fixture says. */
async function insertMembership(
  t: T,
  playerId: Id<"players">,
  sportId: Id<"selectorOptions">,
  nameNormalized: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("playerSports", { playerId, sportId, nameNormalized });
  });
}

async function dryRun(t: T): Promise<RekeyRunReport> {
  return (await t.action(internal.rekeyEntityNames.run, {})) as RekeyRunReport;
}

function groupsFor(report: RekeyRunReport, scope: string) {
  return report.collisions.filter((c) => c.scope === scope && c.key === NEW_KEY);
}

describe("rekeyEntityNames: collisions in a player's extra sports", () => {
  test("fixtures are what they claim: the stale key really changes", () => {
    expect(normalizeEntityName("C. J. Kayfus")).toBe(NEW_KEY);
    expect(normalizeEntityName("CJ Kayfus")).toBe(NEW_KEY);
  });

  test("a re-keyed player's membership meets another player's home row in that sport", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const moving = await insertPlayer(t, {
      name: "C. J. Kayfus",
      sportId: baseball,
      nameNormalized: OLD_KEY,
    });
    await insertMembership(t, moving, football, OLD_KEY);
    const resident = await insertPlayer(t, {
      name: "CJ Kayfus",
      sportId: football,
      nameNormalized: NEW_KEY,
    });

    const report = await dryRun(t);

    // Nothing in the home sport: nobody else is called that in baseball.
    expect(groupsFor(report, "Baseball")).toEqual([]);
    const football_ = groupsFor(report, "Football");
    expect(football_).toHaveLength(1);
    expect(football_[0].table).toBe("players");
    expect(football_[0].policy).toBe("written");
    expect(football_[0].members.map((m) => [m.id, m.changed]).sort()).toEqual(
      [
        [moving as string, true],
        [resident as string, false],
      ].sort(),
    );
    // The membership row is still planned for its own rewrite.
    expect(report.tables.find((r) => r.table === "playerSports")?.toRekey).toBe(1);
    expect(report.collisionCount).toBe(1);
  });

  test("a player re-keyed at home meets another player's membership of that sport", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const moving = await insertPlayer(t, {
      name: "C. J. Kayfus",
      sportId: football,
      nameNormalized: OLD_KEY,
    });
    const member = await insertPlayer(t, {
      name: "CJ Kayfus",
      sportId: baseball,
      nameNormalized: NEW_KEY,
    });
    await insertMembership(t, member, football, NEW_KEY);

    const report = await dryRun(t);

    const football_ = groupsFor(report, "Football");
    expect(football_).toHaveLength(1);
    expect(football_[0].table).toBe("players");
    expect(football_[0].members.map((m) => m.id).sort()).toEqual(
      [moving as string, member as string].sort(),
    );
    expect(report.collisionCount).toBe(1);
  });

  test("a home row and a membership both moving onto one key in one sport are one group", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    // Neither holds the new key yet, so no holder read can see the other:
    // only the grouping brings them together.
    const viaMembership = await insertPlayer(t, {
      name: "C. J. Kayfus",
      sportId: baseball,
      nameNormalized: OLD_KEY,
    });
    await insertMembership(t, viaMembership, football, OLD_KEY);
    const atHome = await insertPlayer(t, {
      name: "C J Kayfus",
      sportId: football,
      nameNormalized: OLD_KEY,
    });

    const report = await dryRun(t);

    const football_ = groupsFor(report, "Football");
    expect(football_).toHaveLength(1);
    expect(football_[0].table).toBe("players");
    expect(football_[0].members.map((m) => [m.id, m.changed]).sort()).toEqual(
      [
        [viaMembership as string, true],
        [atHome as string, true],
      ].sort(),
    );
  });

  test("a lone multi-sport player is no collision with itself, in either sport", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const solo = await insertPlayer(t, {
      name: "C. J. Kayfus",
      sportId: baseball,
      nameNormalized: OLD_KEY,
    });
    await insertMembership(t, solo, football, OLD_KEY);

    const report = await dryRun(t);

    expect(report.collisionCount).toBe(0);
    expect(report.tables.find((r) => r.table === "players")?.toRekey).toBe(1);
    expect(report.tables.find((r) => r.table === "playerSports")?.toRekey).toBe(1);
  });

  test("a holder whose membership is itself moving away is not counted", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const moving = await insertPlayer(t, {
      name: "C. J. Kayfus",
      sportId: football,
      nameNormalized: OLD_KEY,
    });
    // This player's membership copy still says "cj kayfus", but he has since
    // been renamed: the apply pass rewrites that copy to his own key, so he
    // is leaving the key, not holding it.
    const renamed = await insertPlayer(t, {
      name: "Carl Kayfus",
      sportId: baseball,
      nameNormalized: normalizeEntityName("Carl Kayfus"),
    });
    await insertMembership(t, renamed, football, NEW_KEY);

    const report = await dryRun(t);

    expect(groupsFor(report, "Football")).toEqual([]);
    expect(moving).toBeDefined();
  });
});
