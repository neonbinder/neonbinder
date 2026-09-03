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
 * **What convex-test does and does not model about search indexes.**
 * `withSearchIndex` IS supported (convex-test 0.0.55, `evaluateSearchFilter`)
 * and honours `filterFields`, so the sport filter and the "does a search hit
 * come back at all" behaviour are real here. Its matching is an approximation
 * of the real backend, in three ways that matter when reading a failure:
 *
 *   1. It splits the document field on WHITESPACE only, where Convex's
 *      `SimpleTokenizer` also splits on punctuation. "St. Louis" is one
 *      document word `st.` locally and two terms (`st`, `louis`) in
 *      production.
 *   2. It prefix-matches EVERY query term; Convex prefix-matches only the
 *      final term.
 *   3. It applies no relevance ranking at all — results come back in table
 *      order, where Convex returns them BM25-ordered.
 *
 * (3) is why nothing below asserts an ORDER that depends on the search index,
 * and why the `nearMatches` ordering cases seed few enough rows that all of
 * them survive the `.take(10)` — the ordering under test is
 * `rankTeamCandidates`'s, which is pure and covered exhaustively in
 * `convex/lib/entityNearMatch.test.ts`. (1) and (2) also mean a search MISS
 * staged locally is a miss for local reasons: the one case below that drives
 * the fallback query says so in its own comment, and claims only that the
 * branch runs and answers correctly.
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

  test("finds the full club name from an abbreviated city", async () => {
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

  /**
   * Exercises the SECOND search — the longest-token fallback that runs only
   * when the whole-name query comes back empty.
   *
   * Honest about what stages the miss: convex-test splits document text on
   * whitespace only, so the query terms "n.y." and "yankees." (periods
   * attached) prefix-match no document word and the whole-name search finds
   * nothing. Convex's real tokenizer splits on punctuation and would have
   * matched directly. So this proves the fallback BRANCH runs and returns the
   * right row — not that production reaches it by this route. In production
   * the branch earns its place against BM25 crowding, which convex-test models
   * not at all (see the header).
   */
  test("falls back to the longest token when the whole-name search misses", async () => {
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
