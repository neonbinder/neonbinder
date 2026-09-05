/**
 * NEO-236 — the dedup pin. One split row, every identity path, one row left.
 *
 * ## What this file is defending
 *
 * `teams.name` became the nickname ("Padres") and `teams.location` the place
 * ("San Diego"). The dedup key is derived from the COMPOSED full name:
 *
 *     nameNormalized === normalizeTeamName(teamFullName(row))
 *
 * `normalizeTeamName` token-SORTS, so moving a leading word out of `name` and
 * into `location` cannot change the key. That single property is what makes
 * the split safe to roll out row by row: a split row and an unsplit row still
 * dedupe against each other, and every path that resolved a full string onto a
 * row before still resolves onto the same row.
 *
 * The failure mode this exists to catch is quiet and expensive. A writer that
 * derives `nameNormalized` from `name` alone stores "padres" beside a row
 * keyed "diego padres san", and the next lookup for "San Diego Padres" finds
 * nothing and creates a SECOND Padres — at which point cards, listings and
 * spine labels are split across two rows with no error anywhere. Nothing about
 * that shows up in a type check or in a test of the writer itself; it only
 * shows up as two rows, which is what this file counts.
 *
 * So every case below asserts BOTH halves: the path resolved to the pinned
 * row, AND the table still holds exactly one team.
 *
 * The last test is a source grep rather than a behaviour test, in the style of
 * `publicFunctionAuth.test.ts`. A behaviour test can only pin the writers that
 * exist today; the grep is what catches the eighth writer somebody adds next
 * year by copying its neighbour.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };

const FULL_NAME = "San Diego Padres";

/**
 * The fixture: ONE split Padres row, under a real sport row.
 *
 * `nameNormalized` is written with `normalizeTeamName(FULL_NAME)` — the whole
 * name — rather than with the nickname. That is not a convenience; it is the
 * invariant being pinned, and writing it any other way would make every
 * assertion below pass for the wrong reason.
 */
async function seedSplitPadres(t: ReturnType<typeof convexTest>): Promise<{
  sportId: Id<"selectorOptions">;
  teamId: Id<"teams">;
}> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    });
    const teamId = await ctx.db.insert("teams", {
      name: "Padres",
      location: "San Diego",
      nameNormalized: normalizeTeamName(FULL_NAME),
      sportId,
      lastUpdated: 1_700_000_000_000,
    });
    return { sportId, teamId };
  });
}

const allTeams = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("teams").collect());

describe("NEO-236 dedup pin: every identity path lands on the one split row", () => {
  test("findOrCreate with the FULL name reuses it — no second row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);

    const found = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: FULL_NAME, sportId });

    expect(found).toBe(teamId);
    expect(await allTeams(t)).toHaveLength(1);
  });

  test("findOrCreate with Location + Name reuses it — the operator's own input shape", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);

    const found = await t.withIdentity(ADMIN).mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
    });

    expect(found).toBe(teamId);
    expect(await allTeams(t)).toHaveLength(1);
  });

  test("findByFullNameInternal resolves it and never inserts", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);

    await expect(
      t.query(internal.teams.findByFullNameInternal, {
        name: FULL_NAME,
        sportId,
      }),
    ).resolves.toBe(teamId);
    expect(await allTeams(t)).toHaveLength(1);
  });

  test("findByNameAndSport resolves it", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);

    const row = await t
      .withIdentity(ADMIN)
      .query(api.teams.findByNameAndSport, { name: FULL_NAME, sportId });

    expect(row?._id).toBe(teamId);
    expect(row?.name).toBe("Padres");
    expect(row?.location).toBe("San Diego");
  });

  test("resolveNames reports it as existing for both word orders, under its FULL name", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);

    // "Padres, San Diego" is the second entry precisely because
    // `normalizeTeamName` token-sorts: a marketplace that writes the name
    // backwards must not create a duplicate.
    const results = await t
      .withIdentity(ADMIN)
      .query(api.teams.resolveNames, {
        names: [FULL_NAME, "Padres, San Diego"],
        sportId,
      });

    expect(results).toEqual([
      { name: FULL_NAME, existingTeamId: teamId, existingName: FULL_NAME },
      {
        name: "Padres, San Diego",
        existingTeamId: teamId,
        // The FULL name, not the nickname: the wizard shows this to say
        // "this is the row you would be reusing".
        existingName: FULL_NAME,
      },
    ]);
  });

  test("nearMatches ranks it EXACT for the full name, and returns the full name", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);

    const matches = await t
      .withIdentity(ADMIN)
      .query(api.teams.nearMatches, { name: FULL_NAME, sportId });

    expect(matches).toContainEqual({
      _id: teamId,
      name: FULL_NAME,
      confidence: "exact",
    });
  });

  test("search on the LOCATION alone finds it", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);

    // The reason `search_name` indexes `nameNormalized` rather than `name`
    // (NEO-236 decision 1): after the split, `name` is "Padres" and an
    // operator typing "San Diego" into a picker would find nothing.
    const hits = await t
      .withIdentity(ADMIN)
      .query(api.teams.search, { query: "San Diego", sportId });

    expect(hits.map((h) => h._id)).toEqual([teamId]);
  });

  test("all of them together still leave exactly one row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);
    const asAdmin = t.withIdentity(ADMIN);

    await asAdmin.mutation(api.teams.findOrCreate, { name: FULL_NAME, sportId });
    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Padres",
      location: "San Diego",
      sportId,
    });
    await asAdmin.mutation(api.teams.findOrCreate, {
      name: "Padres, San Diego",
      sportId,
    });
    await t.query(internal.teams.findByFullNameInternal, { name: FULL_NAME, sportId });
    await asAdmin.query(api.teams.resolveNames, { names: [FULL_NAME], sportId });
    await asAdmin.query(api.teams.nearMatches, { name: FULL_NAME, sportId });

    const teams = await allTeams(t);
    expect(teams).toHaveLength(1);
    expect(teams[0]._id).toBe(teamId);
  });
});

describe("NEO-236: saveTeamFields owns the key, and defends it", () => {
  test("changing the location CHANGES the dedup key — the split is not cosmetic", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedSplitPadres(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.saveTeamFields, { id: teamId, location: "SD" });

    const team = (await allTeams(t))[0];
    expect(team.location).toBe("SD");
    expect(team.name).toBe("Padres");
    // "SD Padres", not "San Diego Padres" — the row is now a different team as
    // far as every identity lookup is concerned, which is exactly why the
    // collision check below exists.
    expect(team.nameNormalized).toBe(normalizeTeamName("SD Padres"));
    expect(team.nameNormalized).not.toBe(normalizeTeamName(FULL_NAME));
  });

  test("clearing the location with null leaves a location-less team, keyed on the nickname", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedSplitPadres(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.saveTeamFields, { id: teamId, location: null });

    const team = (await allTeams(t))[0];
    expect(team.location).toBeUndefined();
    expect(team.nameNormalized).toBe(normalizeTeamName("Padres"));
  });

  test("an edit that would collide with ANOTHER team in the sport is refused", async () => {
    const t = convexTest(schema, modules);
    const { sportId, teamId } = await seedSplitPadres(t);
    // A second, unsplit row an operator might reasonably try to merge into by
    // editing the first one's location.
    await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Los Angeles Padres",
        nameNormalized: normalizeTeamName("Los Angeles Padres"),
        sportId,
        lastUpdated: 1_700_000_000_000,
      }),
    );

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
        id: teamId,
        location: "Los Angeles",
      }),
    ).rejects.toThrow(/already called Los Angeles Padres/);

    // Nothing moved.
    const padres = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(padres!.location).toBe("San Diego");
    expect(padres!.nameNormalized).toBe(normalizeTeamName(FULL_NAME));
  });

  test("a collision in a DIFFERENT sport is not a collision", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedSplitPadres(t);
    await t.run(async (ctx) => {
      const otherSportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Basketball",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
      await ctx.db.insert("teams", {
        name: "Los Angeles Padres",
        nameNormalized: normalizeTeamName("Los Angeles Padres"),
        sportId: otherSportId,
        lastUpdated: 1_700_000_000_000,
      });
    });

    await t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
      id: teamId,
      location: "Los Angeles",
    });

    const padres = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(padres!.nameNormalized).toBe(normalizeTeamName("Los Angeles Padres"));
  });

  test("saving a row onto its OWN key is not a collision with itself", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedSplitPadres(t);

    await t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
      id: teamId,
      name: "Padres",
      location: "San Diego",
    });

    const padres = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(padres!.nameNormalized).toBe(normalizeTeamName(FULL_NAME));
  });

  /**
   * NEO-236 security review — the create path's length cap applied to an edit.
   *
   * `findOrCreate` has refused an over-long name since NEO-208, but
   * `saveTeamFields` did not — which made the edit form the way around it:
   * create "Padres", then rename it to anything at all. A team name is a
   * globally-shared string rendered on spine labels, in listing titles and in
   * every picker, and it is what a Wikidata lookup gets pointed at.
   */
  test("an over-long name is refused on EDIT, not just on create", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedSplitPadres(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
        id: teamId,
        name: "z".repeat(121),
      }),
    ).rejects.toThrow(/the limit is 120/);

    const padres = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(padres!.name).toBe("Padres");
  });

  test("the cap is on the COMPOSED name — two legal halves can still be too long", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedSplitPadres(t);

    // Each half is well under the cap; together with the joining space they
    // are 121. However it was typed, that is a 121-character team.
    await expect(
      t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
        id: teamId,
        location: "L".repeat(60),
        name: "N".repeat(60),
      }),
    ).rejects.toThrow(/121 characters; the limit is 120/);

    const padres = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(padres!.location).toBe("San Diego");
  });

  test("a composed name exactly at the cap is allowed", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedSplitPadres(t);

    // 59 + 1 + 60 = 120. The bound is inclusive, so this is the last legal
    // name rather than the first illegal one.
    await t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
      id: teamId,
      location: "L".repeat(59),
      name: "N".repeat(60),
    });

    const padres = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(padres!.location).toHaveLength(59);
    expect(padres!.name).toHaveLength(60);
  });

  test("an empty name is still refused", async () => {
    const t = convexTest(schema, modules);
    const { teamId } = await seedSplitPadres(t);

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.teams.saveTeamFields, { id: teamId, name: "   " }),
    ).rejects.toThrow(/cannot be empty/);
  });
});

/**
 * NEO-236 — the structural half of the pin.
 *
 * `convex/lib/teamRow.ts#teamRowFields` is the ONE place a `teams` row's
 * identity fields are derived. A writer that computes `nameNormalized` by hand
 * is the duplicate-Padres bug in the abstract, and it cannot be caught by
 * testing the writers we know about — so this reads the source.
 *
 * Deliberately narrow. It does not police reads (`normalizeTeamName` is fine
 * in a lookup), only INSERTS into `teams`: an insert that names
 * `nameNormalized` in its literal has computed it somewhere, and the only
 * sanctioned way to have computed it is `teamRowFields`.
 */
describe("NEO-236: no writer derives a team's dedup key by hand", () => {
  const CONVEX_DIR = __dirname;

  /** Every `.ts` under convex/, excluding tests and generated code. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "_generated" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        sourceFiles(full, out);
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        out.push(full);
      }
    }
    return out;
  }

  /**
   * The object literal an insert is given, brace-matched from the `{` after
   * the table name. Crude slicing (read to the next `});`) gets this wrong the
   * moment a literal nests one — and getting it wrong here means the check
   * silently narrows rather than failing.
   */
  function insertBodies(src: string): string[] {
    const bodies: string[] = [];
    const NEEDLE = 'db.insert("teams"';
    let index = src.indexOf(NEEDLE);
    while (index !== -1) {
      // Skip a mention inside a comment — several doc comments name this call.
      const lineStart = src.lastIndexOf("\n", index) + 1;
      const linePrefix = src.slice(lineStart, index).trimStart();
      if (!linePrefix.startsWith("*") && !linePrefix.startsWith("//")) {
        const open = src.indexOf("{", index + NEEDLE.length);
        if (open !== -1) {
          let depth = 0;
          let cursor = open;
          for (; cursor < src.length; cursor += 1) {
            if (src[cursor] === "{") depth += 1;
            else if (src[cursor] === "}") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          bodies.push(src.slice(open, cursor + 1));
        }
      }
      index = src.indexOf(NEEDLE, index + 1);
    }
    return bodies;
  }

  test("every `db.insert(\"teams\"` spreads teamRowFields rather than naming nameNormalized", () => {
    const offenders: string[] = [];
    let inserts = 0;

    for (const file of sourceFiles(CONVEX_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const body of insertBodies(src)) {
        inserts += 1;
        const derivesByHand =
          /\bnameNormalized\s*:/.test(body) && !body.includes("teamRowFields(");
        if (derivesByHand) offenders.push(file.slice(CONVEX_DIR.length + 1));
      }
    }

    // Positive control: this check is worthless if it stops finding the
    // inserts at all (a renamed table, a helper wrapping `db.insert`). There
    // are a handful today; the number is not the point, "more than zero" is.
    expect(inserts).toBeGreaterThan(0);

    // If this fails: the named insert computed a dedup key itself. Route it
    // through `teamRowFields({ name, location })` from convex/lib/teamRow.ts —
    // and if the path has no operator to supply a location, ask whether it
    // should be inserting a team at all (NEO-236: automatic paths LINK).
    expect(offenders).toEqual([]);
  });

  test("the check would actually catch a hand-derived key", () => {
    // A guard on the guard. The detector above is string matching over source,
    // which is exactly the kind of check that quietly stops matching; this
    // pins its behaviour on a known-bad and a known-good fixture.
    const bad = `
      await ctx.db.insert("teams", {
        name,
        nameNormalized: normalizeTeamName(name),
        sportId,
      });
    `;
    const good = `
      await ctx.db.insert("teams", {
        ...teamRowFields({ name, location }),
        sportId,
      });
    `;
    const derives = (src: string) =>
      insertBodies(src).some(
        (body) =>
          /\bnameNormalized\s*:/.test(body) && !body.includes("teamRowFields("),
      );
    expect(derives(bad)).toBe(true);
    expect(derives(good)).toBe(false);
  });

  test("the identity helpers are where they are documented to be", () => {
    // A guard on the guard: the grep above passes vacuously if the module it
    // points at has been moved or renamed.
    const src = readFileSync(join(CONVEX_DIR, "lib", "teamRow.ts"), "utf8");
    expect(src).toContain("export function teamRowFields(");
    expect(src).toContain("export async function findTeamByFullName(");
  });
});
