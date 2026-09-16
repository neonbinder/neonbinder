/**
 * NEO-284 — team aliases: normalisation bounds, the `teamAliases` index diff,
 * and the writers that touch both copies.
 *
 * Mirrors `playerAliases.test.ts`, with the team-specific differences called
 * out at each test: 64 x 120 rather than 32 x 64 (a team alias is a whole
 * name, not a nickname), aliases written on `findOrCreate`'s INSERT branch
 * only, and the advisory `aliasesInUse` query.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  normalizeTeamAliasList,
  syncTeamAliases,
  normalizeTeamName,
} from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_team_alias_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_team_alias_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T, value = "Baseball") {
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

const aliasRows = (t: T) =>
  t.run(async (ctx) => ctx.db.query("teamAliases").collect());

// ===========================================================================
// normalizeTeamAliasList
// ===========================================================================

describe("NEO-284: normalizeTeamAliasList bounds and dedupe", () => {
  test("refuses over 64 entries, naming only the count", () => {
    const raw = Array.from({ length: 65 }, (_, i) => `Team ${i}`);
    expect(() => normalizeTeamAliasList(raw, "San Diego Padres")).toThrow(
      /65 aliases; the limit is 64/,
    );
    // The message never carries the alias strings themselves — they are
    // operator input that reaches Sentry and the browser console.
    try {
      normalizeTeamAliasList(raw, "San Diego Padres");
      throw new Error("expected throw");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("Team 0");
    }
  });

  test("refuses an entry over 120 characters, naming only the length", () => {
    const tooLong = "x".repeat(121);
    expect(() =>
      normalizeTeamAliasList([tooLong], "San Diego Padres"),
    ).toThrow(/121 characters; the limit is 120/);
    try {
      normalizeTeamAliasList([tooLong], "San Diego Padres");
      throw new Error("expected throw");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(tooLong);
    }
  });

  test("an entry that normalises to the row's own FULL name is dropped", () => {
    const out = normalizeTeamAliasList(
      ["San Diego Padres", "Padres", "Friars"],
      "San Diego Padres",
    );
    expect(out).toEqual(["Padres", "Friars"]);
  });

  test("the nickname ALONE is kept — it is not the full name", () => {
    // "Padres" is a legitimate alias for "San Diego Padres" precisely because
    // NEO-236 keyed the whole name.
    const out = normalizeTeamAliasList(["Padres"], "San Diego Padres");
    expect(out).toEqual(["Padres"]);
  });

  test("dedupes on the token-sorted key the index stores", () => {
    const out = normalizeTeamAliasList(
      ["LSU Tigers", "Tigers LSU"],
      "Louisiana State University Tigers",
    );
    expect(out).toEqual(["LSU Tigers"]);
  });
});

// ===========================================================================
// syncTeamAliases — the index diff
// ===========================================================================

describe("NEO-284: syncTeamAliases diffs against by_team_id", () => {
  test("no writes when the alias list is unchanged", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    await t.run((ctx) =>
      syncTeamAliases(ctx, { teamId, sportId, aliases: ["Friars"] }),
    );
    const before = await aliasRows(t);
    expect(before).toHaveLength(1);
    const beforeId = before[0]._id;

    await t.run((ctx) =>
      syncTeamAliases(ctx, { teamId, sportId, aliases: ["Friars"] }),
    );
    const after = await aliasRows(t);
    // Same row, not deleted-and-reinserted.
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(beforeId);
  });

  test("a stale row (alias no longer wanted) is deleted", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    await t.run((ctx) =>
      syncTeamAliases(ctx, { teamId, sportId, aliases: ["Friars", "SD Padres"] }),
    );
    await t.run((ctx) =>
      syncTeamAliases(ctx, { teamId, sportId, aliases: ["Friars"] }),
    );
    const rows = await aliasRows(t);
    expect(rows.map((r) => r.aliasNormalized)).toEqual([
      normalizeTeamName("Friars"),
    ]);
  });

  test("a wrong-sport row for a matching alias is treated as stale, not held", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const otherSport = await seedSport(t, "Basketball");
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    // A residue row filed under the wrong sport (predates a fix, or a bug).
    await t.run((ctx) =>
      ctx.db.insert("teamAliases", {
        teamId,
        sportId: otherSport,
        aliasNormalized: normalizeTeamName("Friars"),
      }),
    );
    await t.run((ctx) =>
      syncTeamAliases(ctx, { teamId, sportId, aliases: ["Friars"] }),
    );
    const rows = await aliasRows(t);
    // The wrong-sport row was deleted and a fresh, correctly-sported one
    // inserted — not held as-is.
    expect(rows).toHaveLength(1);
    expect(rows[0].sportId).toBe(sportId);
  });

  test("a missing alias (wanted, not yet indexed) is inserted", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Padres",
        location: "San Diego",
        nameNormalized: normalizeTeamName("San Diego Padres"),
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    await t.run((ctx) =>
      syncTeamAliases(ctx, { teamId, sportId, aliases: ["Friars"] }),
    );
    expect(await aliasRows(t)).toHaveLength(1);
  });
});

// ===========================================================================
// saveTeamFields({ aliases })
// ===========================================================================

describe("NEO-284: saveTeamFields writes both copies", () => {
  test("writes the row's aliases column and the teamAliases index", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
    });

    await asAdmin.mutation(api.teams.saveTeamFields, {
      id,
      aliases: ["Friars", "SD Padres"],
    });

    const team = await t.run(async (ctx) => ctx.db.get(id));
    expect(team!.aliases).toEqual(["Friars", "SD Padres"]);
    expect((await aliasRows(t)).map((r) => r.aliasNormalized).sort()).toEqual(
      [normalizeTeamName("Friars"), normalizeTeamName("SD Padres")].sort(),
    );
  });

  test("a rename re-normalises the alias list against the NEW full name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
      aliases: ["SD Padres"],
    });

    // Rename to "SD" / "Padres" while the alias box still carries the string
    // that is about to BECOME the full name — it must be dropped, even
    // though it was a legitimate alias under the old name.
    await asAdmin.mutation(api.teams.saveTeamFields, {
      id,
      location: "SD",
      aliases: ["SD Padres", "Friars"],
    });

    const team = await t.run(async (ctx) => ctx.db.get(id));
    expect(team!.aliases).toEqual(["Friars"]);
  });
});

// ===========================================================================
// findOrCreate({ aliases })
// ===========================================================================

describe("NEO-284: findOrCreate writes aliases on INSERT only", () => {
  test("the FIND branch does not widen an existing row's aliases", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
      aliases: ["Friars"],
    });
    let team = await t.run(async (ctx) => ctx.db.get(id));
    expect(team!.aliases).toEqual(["Friars"]);

    // Same era, so this call resolves to the FIND branch. New aliases must
    // not silently land on the row.
    const again = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
      aliases: ["Swinging Friars"],
    });
    expect(again).toBe(id);

    team = await t.run(async (ctx) => ctx.db.get(id));
    expect(team!.aliases).toEqual(["Friars"]);
  });

  test("the INSERT branch writes both copies", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await t.withIdentity(ADMIN_IDENTITY).mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
      aliases: ["Friars", "Padres"],
    });
    const team = await t.run(async (ctx) => ctx.db.get(id));
    // "Padres" alone does not equal the full name "San Diego Padres" so it
    // is kept; only an entry equal to the FULL name is dropped.
    expect(team!.aliases).toEqual(["Friars", "Padres"]);
    expect(await aliasRows(t)).toHaveLength(2);
  });
});

// ===========================================================================
// aliasesInUse — advisory
// ===========================================================================

describe("NEO-284: aliasesInUse is admin-gated and advisory", () => {
  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.query(api.teams.aliasesInUse, { sportId, aliases: ["Friars"] }),
    ).rejects.toThrow();
  });

  test("reports the other team's full name for a shared alias, self excluded", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const padres = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
      aliases: ["Friars"],
    });
    const missions = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Missions",
      location: "San Antonio",
      sportId,
    });

    expect(
      await asAdmin.query(api.teams.aliasesInUse, {
        sportId,
        aliases: ["Friars", "Nobody"],
        selfId: missions,
      }),
    ).toEqual([{ alias: "Friars", name: "San Diego Padres" }]);

    // Not reported against the row that already owns it.
    expect(
      await asAdmin.query(api.teams.aliasesInUse, {
        sportId,
        aliases: ["Friars"],
        selfId: padres,
      }),
    ).toEqual([]);
  });

  test("bounded to 64 aliases even when more are passed", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    // A caller passing 70 entries must not cost 70 index reads — the query
    // silently truncates rather than refusing, since it is advisory.
    const many = Array.from({ length: 70 }, (_, i) => `Alias ${i}`);
    await expect(
      asAdmin.query(api.teams.aliasesInUse, { sportId, aliases: many }),
    ).resolves.toEqual([]);
  });
});
