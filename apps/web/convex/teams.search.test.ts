/**
 * NEO-212 — `teams.search`, `teams.resolveNames` and `teams.nearMatches`: the
 * three queries that stop the entity review wizard creating a second row for a
 * team we already have.
 *
 * Before this, commit-time dedup was normalized-equality only, so "Yankees",
 * "New York Yankees" and "NY Yankees" were three franchises and the wizard
 * warned about none of it. These cases lock the three shapes that fix it: free
 * typeahead, an exact bulk existence check, and a fuzzy per-name prompt.
 *
 * NEO-236 moved the `search_name` index off `name` and onto `nameNormalized`,
 * and normalised the QUERY to match (lowercased, punctuation-stripped, source
 * order kept — see `teams.search`). Nothing below changed expectation as a
 * result: every case here still asserts the same rows. What did change is that
 * the longest-token fallback is no longer reachable from a test — see the note
 * on that case.
 *
 * **What convex-test does and does not model about search indexes.**
 * `withSearchIndex` IS supported (convex-test 0.0.55, `evaluateSearchFilter`)
 * and honours `filterFields`, so the sport filter and the "does a search hit
 * come back at all" behaviour are real here. Its matching is an approximation
 * of the real backend, in three ways that matter when reading a failure:
 *
 *   1. It splits the document field on WHITESPACE only, where Convex's
 *      `SimpleTokenizer` also splits on punctuation. Since NEO-236 this no
 *      longer bites for teams: `nameNormalized` has already had its
 *      punctuation stripped by `normalizeTeamName`, so the local document
 *      words and production's terms finally agree.
 *   2. It prefix-matches EVERY query term; Convex prefix-matches only the
 *      final term.
 *   3. It applies no relevance ranking at all — results come back in table
 *      order, where Convex returns them BM25-ordered.
 *
 * Both engines are OR-ish: a document matching ANY query term is a hit
 * (convex-test's `evaluateSearchFilter` uses `queryTerms.some(...)`). That is
 * why `nearMatches` can search a whole name and still find a row storing only
 * part of it.
 *
 * (3) is why nothing below asserts an ORDER that depends on the search index,
 * and why the `nearMatches` ordering cases seed few enough rows that all of
 * them survive the `.take(10)` — the ordering under test is
 * `rankTeamCandidates`'s, which is pure and covered exhaustively in
 * `convex/lib/entityNearMatch.test.ts`.
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

const ADMIN = {
  subject: "user_admin_212",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_admin_212",
  role: "admin",
};

/** Signed in, but not an admin — the gate these queries must reject. */
const MEMBER = {
  subject: "user_member_212",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_member_212",
  role: "user",
};

async function seedSport(
  t: ReturnType<typeof convexTest>,
  value: string,
  skuCode: string,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      sportConfig: { skuCode, league: value.toUpperCase() },
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function seedTeam(
  t: ReturnType<typeof convexTest>,
  name: string,
  sportId: Id<"selectorOptions">,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sportId,
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

describe("teams.search", () => {
  test("returns a team by a leading-word prefix", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "New York Yankees", baseball);
    await seedTeam(t, "Boston Red Sox", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.teams.search, { query: "New Yor" });

    expect(rows.map((r) => r.name)).toEqual(["New York Yankees"]);
  });

  test("honours the sportId filter", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const football = await seedSport(t, "Football", "FB");
    await seedTeam(t, "New York Yankees", baseball);
    await seedTeam(t, "New York Giants", football);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.teams.search, { query: "New York", sportId: football });

    expect(rows.map((r) => r.name)).toEqual(["New York Giants"]);
  });

  test("returns [] when signed out rather than throwing", async () => {
    // Mirrors `players.search`: a signed-out render is a quiet no-op, not an
    // error boundary.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "New York Yankees", baseball);

    expect(await t.query(api.teams.search, { query: "Yankees" })).toEqual([]);
  });

  test("returns [] for a blank or whitespace-only query", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "New York Yankees", baseball);
    const asAdmin = t.withIdentity(ADMIN);

    expect(await asAdmin.query(api.teams.search, { query: "" })).toEqual([]);
    expect(await asAdmin.query(api.teams.search, { query: "   " })).toEqual([]);
  });

  test("caps the result count at 25 however large a limit is asked for", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    for (let i = 0; i < 30; i++) {
      await seedTeam(t, `Springfield Isotopes ${i}`, baseball);
    }

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.teams.search, { query: "Springfield", limit: 500 });

    expect(rows).toHaveLength(25);
  });

  // NEO-212 security review: the cap above had no matching FLOOR. `limit: 0`
  // and negatives reached `.take()`, which rejects a negative outright — and a
  // thrown query inside `useQuery` unmounts the calling component rather than
  // rendering an empty typeahead. Clamping into [1, 25] keeps a nonsense
  // argument a nonsense result instead of a crash.
  test("floors a zero or negative limit to one row instead of throwing", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "Springfield Isotopes", baseball);
    await seedTeam(t, "Springfield Atoms", baseball);
    const asAdmin = t.withIdentity(ADMIN);

    for (const limit of [0, -1, -500]) {
      const rows = await asAdmin.query(api.teams.search, {
        query: "Springfield",
        limit,
      });
      expect(rows).toHaveLength(1);
    }
  });
});

describe("teams.resolveNames", () => {
  test("marks existing rows and leaves new ones unresolved", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const yankeesId = await seedTeam(t, "New York Yankees", baseball);

    const rows = await t.withIdentity(ADMIN).query(api.teams.resolveNames, {
      names: ["New York Yankees", "Seattle Mariners"],
      sportId: baseball,
    });

    expect(rows).toEqual([
      {
        name: "New York Yankees",
        existingTeamId: yankeesId,
        existingName: "New York Yankees",
      },
      { name: "Seattle Mariners" },
    ]);
  });

  test("resolves through the normalised key, not the literal string", async () => {
    // This is the "M already exist" half of the wizard's count: a differently
    // punctuated or reordered spelling must NOT be counted as new, because
    // `findOrCreate` would reuse the row.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const yankeesId = await seedTeam(t, "New York Yankees", baseball);

    const rows = await t.withIdentity(ADMIN).query(api.teams.resolveNames, {
      names: ["Yankees, New York"],
      sportId: baseball,
    });

    expect(rows[0].existingTeamId).toBe(yankeesId);
    expect(rows[0].existingName).toBe("New York Yankees");
  });

  test("does not resolve across sports", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const football = await seedSport(t, "Football", "FB");
    await seedTeam(t, "New York Giants", baseball);

    const rows = await t.withIdentity(ADMIN).query(api.teams.resolveNames, {
      names: ["New York Giants"],
      sportId: football,
    });

    expect(rows).toEqual([{ name: "New York Giants" }]);
  });

  test("answers one entry per input, in order, duplicates included", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "New York Yankees", baseball);

    const rows = await t.withIdentity(ADMIN).query(api.teams.resolveNames, {
      names: ["New York Yankees", "New York Yankees", "New York Mets"],
      sportId: baseball,
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[2].existingTeamId).toBeUndefined();
  });

  test("a punctuation-only name is never reported as existing", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.teams.resolveNames, { names: ["..."], sportId: baseball });

    expect(rows).toEqual([{ name: "..." }]);
  });

  test("accepts exactly 64 names and refuses 65", async () => {
    // Refuses rather than truncates: a silently short answer is a wrong count
    // on the wizard's "will create N new teams" line, which is the one number
    // the operator acts on.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const asAdmin = t.withIdentity(ADMIN);
    const names = (n: number) =>
      Array.from({ length: n }, (_, i) => `Team ${i}`);

    expect(
      await asAdmin.query(api.teams.resolveNames, {
        names: names(64),
        sportId: baseball,
      }),
    ).toHaveLength(64);

    await expect(
      asAdmin.query(api.teams.resolveNames, {
        names: names(65),
        sportId: baseball,
      }),
    ).rejects.toThrow(/max 64/);
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");

    await expect(
      t.query(api.teams.resolveNames, { names: ["Yankees"], sportId: baseball }),
    ).rejects.toThrow(/Not authenticated/);

    await expect(
      t
        .withIdentity(MEMBER)
        .query(api.teams.resolveNames, {
          names: ["Yankees"],
          sportId: baseball,
        }),
    ).rejects.toThrow(/Admin access required/);
  });
});

describe("teams.nearMatches", () => {
  test("reports the same normalised key as exact", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const yankeesId = await seedTeam(t, "New York Yankees", baseball);

    const rows = await t.withIdentity(ADMIN).query(api.teams.nearMatches, {
      name: "Yankees, New York",
      sportId: baseball,
    });

    expect(rows).toEqual([
      { _id: yankeesId, name: "New York Yankees", confidence: "exact" },
    ]);
  });

  // The ticket in one case: this returned nothing, so the wizard created a
  // second Yankees row.
  test("finds the full club name from the nickname alone", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const yankeesId = await seedTeam(t, "New York Yankees", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.teams.nearMatches, { name: "Yankees", sportId: baseball });

    expect(rows).toEqual([
      { _id: yankeesId, name: "New York Yankees", confidence: "close" },
    ]);
  });

  test("finds the full club name from an abbreviated location", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const yankeesId = await seedTeam(t, "New York Yankees", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.teams.nearMatches, { name: "NY Yankees", sportId: baseball });

    expect(rows.map((r) => r._id)).toEqual([yankeesId]);
    expect(rows[0].confidence).toBe("close");
  });

  test("returns nothing for an unrelated name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "New York Yankees", baseball);

    expect(
      await t.withIdentity(ADMIN).query(api.teams.nearMatches, {
        name: "Seattle Mariners",
        sportId: baseball,
      }),
    ).toEqual([]);
  });

  test("never crosses sports", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const football = await seedSport(t, "Football", "FB");
    await seedTeam(t, "New York Giants", baseball);

    expect(
      await t.withIdentity(ADMIN).query(api.teams.nearMatches, {
        name: "New York Giants",
        sportId: football,
      }),
    ).toEqual([]);
  });

  test("puts the exact row first and honours the limit", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "New York Mets", baseball);
    const yankeesId = await seedTeam(t, "New York Yankees", baseball);
    await seedTeam(t, "Yankees", baseball);

    const asAdmin = t.withIdentity(ADMIN);
    const all = await asAdmin.query(api.teams.nearMatches, {
      name: "New York Yankees",
      sportId: baseball,
    });
    expect(all[0]).toEqual({
      _id: yankeesId,
      name: "New York Yankees",
      confidence: "exact",
    });
    expect(all).toHaveLength(3);

    const capped = await asAdmin.query(api.teams.nearMatches, {
      name: "New York Yankees",
      sportId: baseball,
      limit: 1,
    });
    expect(capped).toHaveLength(1);
    expect(capped[0]._id).toBe(yankeesId);
  });

  // NEO-212 security review: floored as well as capped. `limit: 0` returned an
  // empty list, which the wizard reads as "nothing like this exists" — the
  // exact wrong answer from the one query whose job is to warn before a
  // duplicate write — and `limit: -1` made `.slice(0, -1)` drop the last
  // candidate silently.
  test("floors a zero or negative limit to one match instead of returning none", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const yankeesId = await seedTeam(t, "New York Yankees", baseball);
    const asAdmin = t.withIdentity(ADMIN);

    for (const limit of [0, -1, -100]) {
      const rows = await asAdmin.query(api.teams.nearMatches, {
        name: "New York Yankees",
        sportId: baseball,
        limit,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]._id).toBe(yankeesId);
    }
  });

  test("refuses a search term longer than a storable team name", async () => {
    // The same 120-character bound `findOrCreate` puts on a STORED team name.
    // Nothing longer could ever match a stored row, so refusing costs nothing
    // real; an unbounded term otherwise reaches the search index and
    // `rankTeamCandidates`'s per-token work.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "New York Yankees", baseball);
    const asAdmin = t.withIdentity(ADMIN);

    await expect(
      asAdmin.query(api.teams.nearMatches, {
        name: "Y".repeat(121),
        sportId: baseball,
      }),
    ).rejects.toThrow(/121 characters; the limit is 120/);

    await expect(
      asAdmin.query(api.teams.nearMatches, {
        name: "Y".repeat(120),
        sportId: baseball,
      }),
    ).resolves.toEqual([]);
  });

  /**
   * NEO-236 — this case USED to be the only thing exercising the longest-token
   * fallback, and it no longer does. Read that as a finding, not a regression.
   *
   * It worked before only because of a convex-test artefact: the index covered
   * the raw `name`, whose document words keep their punctuation locally, so
   * the query terms "n.y." and "yankees." prefix-matched nothing and the
   * whole-name search came back empty. Production never took that route — its
   * tokenizer strips punctuation on both sides and would have matched
   * directly.
   *
   * Now that the index covers `nameNormalized` and the query is normalised the
   * same way, the first search matches, which is the production behaviour
   * finally being modelled. The assertion below is unchanged and still worth
   * keeping: a punctuation-heavy abbreviation must find the row.
   *
   * The fallback branch itself is now unreachable from ANY input, here or in
   * production, and that was already true before this change. Both engines are
   * OR-ish, and the fallback term is `longestToken(name)` — always one of the
   * whole-name query's own terms. So if the fallback would match, the
   * whole-name search already did, and `hits.length === 0` cannot be true. Its
   * stated purpose (rescuing a row BM25 crowded out of the top ten) needs a
   * different trigger than "no hits at all". Left in place deliberately:
   * changing it is a behaviour change, and NEO-236 WP0 is a rename.
   */
  test("finds the row from a punctuation-heavy abbreviation", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const yankeesId = await seedTeam(t, "Yankees", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.teams.nearMatches, { name: "N.Y. Yankees.", sportId: baseball });

    expect(rows).toEqual([
      { _id: yankeesId, name: "Yankees", confidence: "close" },
    ]);
  });

  test("returns [] for a blank name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedTeam(t, "New York Yankees", baseball);

    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.teams.nearMatches, { name: "   ", sportId: baseball }),
    ).toEqual([]);
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");

    await expect(
      t.query(api.teams.nearMatches, { name: "Yankees", sportId: baseball }),
    ).rejects.toThrow(/Not authenticated/);

    await expect(
      t
        .withIdentity(MEMBER)
        .query(api.teams.nearMatches, { name: "Yankees", sportId: baseball }),
    ).rejects.toThrow(/Admin access required/);
  });
});
