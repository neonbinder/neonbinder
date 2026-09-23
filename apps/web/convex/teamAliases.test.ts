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
  TEAM_NAME_LOOKUP_MAX_OPS,
  TEAM_NAME_LOOKUP_READ_BUDGET,
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

  test("bounds the FAN-OUT as well as the alias count (NEO-296)", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // The preloaded-college shape: ONE alias key that a whole window of teams
    // answers to. Each lookup is then 2 index reads + one `db.get` per holder
    // — 18 system ops — so the 64-alias cap alone allowed ~1,152 of them in a
    // query that re-runs as the operator types.
    for (let i = 0; i < 16; i += 1) {
      await asAdmin.mutation(api.teams.findOrCreate, {
        name: `Hurricanes ${i}`,
        location: "Miami",
        sportId,
        aliases: ["Shared College Name"],
      });
    }

    const asked = Array.from({ length: 64 }, () => "Shared College Name");
    const notes = await asAdmin.query(api.teams.aliasesInUse, {
      sportId,
      aliases: asked,
    });

    // It STOPS rather than throwing: this is a note beside a text box, and a
    // form that blanks because an advisory read got expensive is the worse
    // answer. Derived from the constants, so a change to either re-derives
    // here instead of going stale.
    const affordable = Math.ceil(
      TEAM_NAME_LOOKUP_READ_BUDGET / TEAM_NAME_LOOKUP_MAX_OPS,
    );
    expect(notes).toHaveLength(affordable);
    expect(notes.length).toBeLessThan(asked.length);
    // Every note it did answer is a real holder — a partial scan never
    // invents one, and never reports an alias it did not read.
    expect(new Set(notes.map((n) => n.alias))).toEqual(
      new Set(["Shared College Name"]),
    );
    expect(notes.every((n) => n.name.startsWith("Miami Hurricanes"))).toBe(true);
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

// ===========================================================================
// S1 (security review): an alias may never be another team's PRIMARY name
// ===========================================================================

describe("NEO-284 S1: the writers refuse an alias that is another team's own name", () => {
  test("saveTeamFields refuses, naming the owning team — and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Tigers",
      location: "LSU",
      sportId,
    });
    const rival = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Tigers",
      location: "Auburn",
      sportId,
    });

    await expect(
      asAdmin.mutation(api.teams.saveTeamFields, {
        id: rival,
        aliases: ["War Eagle", "LSU Tigers"],
      }),
    ).rejects.toThrow(/LSU Tigers is already a team in this sport/);

    const row = await t.run((ctx) => ctx.db.get(rival));
    expect(row!.aliases).toBeUndefined();
    expect(await aliasRows(t)).toEqual([]);
  });

  test("the refusal names the team, not an id (NAME_TAKEN's shape is for a different surface)", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const owner = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Tigers",
      location: "LSU",
      sportId,
    });
    const rival = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Tigers",
      location: "Auburn",
      sportId,
    });
    try {
      await asAdmin.mutation(api.teams.saveTeamFields, { id: rival, aliases: ["LSU Tigers"] });
      throw new Error("expected throw");
    } catch (err) {
      const message = String((err as { data?: unknown; message?: string }).data ?? (err as Error).message);
      expect(message).not.toContain(owner);
      expect(message).not.toContain("NAME_TAKEN");
    }
  });

  test("findOrCreate refuses on the INSERT branch and inserts nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Tigers",
      location: "LSU",
      sportId,
    });
    await expect(
      asAdmin.mutation(api.teams.findOrCreate, {
        name: "Tigers",
        location: "Auburn",
        sportId,
        aliases: ["LSU Tigers"],
      }),
    ).rejects.toThrow(/LSU Tigers is already a team in this sport/);
    expect(await t.run((ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });

  test("a disjoint era is not a clash: the 2011- Jets may answer to the 1972-1996 Jets' name", async () => {
    // Same rule `findCollidingTeams` applies: eras that do not overlap are
    // two teams, and an alias that only reaches the other era cannot lock it
    // out — its own saveTeamFields would not collide either.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Jets",
      location: "Winnipeg",
      sportId,
      yearsActive: { from: 1972, to: 1996 },
    });
    const revived = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Thrashers",
      location: "Atlanta",
      sportId,
      yearsActive: { from: 2011 },
    });
    await asAdmin.mutation(api.teams.saveTeamFields, {
      id: revived,
      aliases: ["Winnipeg Jets"],
    });
    expect((await t.run((ctx) => ctx.db.get(revived)))!.aliases).toEqual(["Winnipeg Jets"]);
  });

  test("the guard checks the era this save LEAVES on the row, not the one it had", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Hockey");
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Jets",
      location: "Winnipeg",
      sportId,
      yearsActive: { from: 1972, to: 1996 },
    });
    const revived = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Thrashers",
      location: "Atlanta",
      sportId,
      yearsActive: { from: 2011 },
    });
    // Widening the era back over 1972-1996 in the same save as the alias:
    // the alias would now reach the other Jets, so it is refused.
    await expect(
      asAdmin.mutation(api.teams.saveTeamFields, {
        id: revived,
        yearsActive: { from: 1990 },
        aliases: ["Winnipeg Jets"],
      }),
    ).rejects.toThrow(/Winnipeg Jets is already a team/);
  });

  test("alias-vs-alias stays advisory: two teams may share an alias, and aliasesInUse only reports it", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const redhawks = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "RedHawks",
      location: "Miami",
      sportId,
      aliases: ["Miami"],
    });
    const hurricanes = await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Hurricanes",
      location: "Miami",
      sportId,
    });
    await asAdmin.mutation(api.teams.saveTeamFields, { id: hurricanes, aliases: ["Miami"] });
    expect((await t.run((ctx) => ctx.db.get(hurricanes)))!.aliases).toEqual(["Miami"]);
    expect(
      await asAdmin.query(api.teams.aliasesInUse, { sportId, aliases: ["Miami"], selfId: hurricanes }),
    ).toEqual([{ alias: "Miami", name: "Miami RedHawks" }]);
    expect(redhawks).toBeTruthy();
  });

  test("aliasesInUse drops an over-long entry before the lookup", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
      aliases: ["Friars"],
    });
    // A 121-character string can never equal a stored key; the advisory
    // query answers without it rather than throwing or scanning for it.
    expect(
      await asAdmin.query(api.teams.aliasesInUse, {
        sportId,
        aliases: ["x".repeat(121), "Friars"],
      }),
    ).toEqual([{ alias: "Friars", name: "San Diego Padres" }]);
  });
});
