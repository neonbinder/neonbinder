/**
 * NEO-212 — `players.nearMatches`, the "did you mean?" prompt in front of
 * creating a player from the entity review wizard.
 *
 * The player side of the same bug as `teams.nearMatches`: commit-time dedup is
 * normalized-equality only, so a card front printing "OHTANI" and a back
 * printing "Shohei Ohtani" produced two rows and the wizard flagged neither.
 *
 * **What convex-test does and does not model about search indexes** — the same
 * caveats spelled out at the top of `convex/teams.search.test.ts`: search IS
 * supported and honours `filterFields`, but it splits document text on
 * whitespace only (not punctuation), prefix-matches every term rather than the
 * final one, and applies no relevance ranking. Nothing here asserts an order
 * that depends on the search index; the ordering under test belongs to
 * `rankPlayerCandidates`, which is pure and covered in
 * `convex/lib/entityNearMatch.test.ts`.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { nearMatches, normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "user_admin_212p",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_admin_212p",
  role: "admin",
};

/** Signed in, but not an admin — the gate this query must reject. */
const MEMBER = {
  subject: "user_member_212p",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_member_212p",
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

async function seedPlayer(
  t: ReturnType<typeof convexTest>,
  name: string,
  sportId: Id<"selectorOptions">,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      // Present so a leak of this audit-only field would be visible; the
      // return validator has no slot for it.
      createdByUserId: "user_someone_else",
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

describe("players.nearMatches", () => {
  test("reports the same normalised key as exact", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const troutId = await seedPlayer(t, "Mike Trout", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Trout, Mike", sportId: baseball });

    expect(rows).toEqual([
      { _id: troutId, name: "Mike Trout", confidence: "exact" },
    ]);
  });

  // The ticket, on the player side: a surname-only card front against a
  // full-name row.
  test("finds the full name from a surname alone", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const ohtaniId = await seedPlayer(t, "Shohei Ohtani", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Ohtani", sportId: baseball });

    expect(rows).toEqual([
      { _id: ohtaniId, name: "Shohei Ohtani", confidence: "close" },
    ]);
  });

  test("finds the full name from an initialled first name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const ohtaniId = await seedPlayer(t, "Shohei Ohtani", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "S. Ohtani", sportId: baseball });

    expect(rows.map((r) => r._id)).toEqual([ohtaniId]);
    expect(rows[0].confidence).toBe("close");
  });

  test("initials written without spaces find the spaced row as exact (NEO-322)", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const kayfusId = await seedPlayer(t, "C. J. Kayfus", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "C.J. Kayfus", sportId: baseball });

    expect(rows).toEqual([
      { _id: kayfusId, name: "C. J. Kayfus", confidence: "exact" },
    ]);
  });

  test("returns nothing for an unrelated name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Shohei Ohtani", baseball);

    expect(
      await t.withIdentity(ADMIN).query(api.players.nearMatches, {
        name: "Mike Trout",
        sportId: baseball,
      }),
    ).toEqual([]);
  });

  test("a shared surname with different first names is not a match", async () => {
    // Rung 5 of the `lib/pairing/names.ts` ladder: surnames agree, first names
    // genuinely disagree, so these are two people and the wizard says nothing.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Steve Trout", baseball);

    expect(
      await t.withIdentity(ADMIN).query(api.players.nearMatches, {
        name: "Mike Trout",
        sportId: baseball,
      }),
    ).toEqual([]);
  });

  test("never crosses sports", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const football = await seedSport(t, "Football", "FB");
    await seedPlayer(t, "Shohei Ohtani", baseball);

    expect(
      await t.withIdentity(ADMIN).query(api.players.nearMatches, {
        name: "Shohei Ohtani",
        sportId: football,
      }),
    ).toEqual([]);
  });

  /**
   * Exercises the SECOND search — the surname fallback that runs only when the
   * full-name query comes back empty.
   *
   * Honest about what stages the miss: convex-test splits document text on
   * whitespace only, so the query term "Ohtani." (with its period) fails to
   * prefix-match the document word "ohtani", and the whole-name search finds
   * nothing. Convex's real tokenizer splits on punctuation and would have
   * matched directly. So this proves the fallback BRANCH runs and returns the
   * right row — not that production reaches it by this route. In production
   * the branch earns its place against BM25 crowding, which convex-test models
   * not at all (see the header).
   */
  test("falls back to the surname when the whole-name search misses", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const ohtaniId = await seedPlayer(t, "Ohtani", baseball);

    const rows = await t.withIdentity(ADMIN).query(api.players.nearMatches, {
      name: "Shohei Ohtani.",
      sportId: baseball,
    });

    expect(rows).toEqual([
      { _id: ohtaniId, name: "Ohtani", confidence: "close" },
    ]);
  });

  test("puts the exact row first and honours the limit", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Ohtani", baseball);
    const ohtaniId = await seedPlayer(t, "Shohei Ohtani", baseball);
    await seedPlayer(t, "S. Ohtani", baseball);

    const asAdmin = t.withIdentity(ADMIN);
    const all = await asAdmin.query(api.players.nearMatches, {
      name: "Shohei Ohtani",
      sportId: baseball,
    });
    expect(all[0]).toEqual({
      _id: ohtaniId,
      name: "Shohei Ohtani",
      confidence: "exact",
    });
    expect(all).toHaveLength(3);

    const capped = await asAdmin.query(api.players.nearMatches, {
      name: "Shohei Ohtani",
      sportId: baseball,
      limit: 1,
    });
    expect(capped).toHaveLength(1);
    expect(capped[0]._id).toBe(ohtaniId);
  });

  // NEO-212 security review: the `limit` argument is client-supplied and was
  // only capped, never floored. `limit: 0` returned an empty array, which the
  // wizard reads as "nothing like this exists" — the exact wrong answer from
  // the one query whose job is to warn before a duplicate write — and
  // `limit: -1` made the handler's `.slice(0, -1)` silently drop the last
  // candidate. Neither leaks anything; both defeat the warning.
  test("floors a zero or negative limit to one match instead of returning none", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const ohtaniId = await seedPlayer(t, "Shohei Ohtani", baseball);
    const asAdmin = t.withIdentity(ADMIN);

    for (const limit of [0, -1, -100]) {
      const rows = await asAdmin.query(api.players.nearMatches, {
        name: "Shohei Ohtani",
        sportId: baseball,
        limit,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]._id).toBe(ohtaniId);
    }
  });

  test("refuses a search term longer than a storable player name", async () => {
    // The same 120-character bound `createByAdmin` and `savePlayerFields` put
    // on a STORED name. Nothing longer than a storable name could ever match a
    // stored row, so refusing costs nothing real — and an unbounded term
    // otherwise reaches the search index and the ranker's per-token work.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Mike Trout", baseball);
    const asAdmin = t.withIdentity(ADMIN);

    await expect(
      asAdmin.query(api.players.nearMatches, {
        name: "M".repeat(121),
        sportId: baseball,
      }),
    ).rejects.toThrow(/121 characters; the limit is 120/);

    // 120 exactly is still accepted — the bound is a limit, not an off-by-one.
    await expect(
      asAdmin.query(api.players.nearMatches, {
        name: "M".repeat(120),
        sportId: baseball,
      }),
    ).resolves.toEqual([]);
  });

  test("returns only _id, name and confidence — never createdByUserId", async () => {
    // `players` rows carry an audit-only `createdByUserId` that must not reach
    // the client; see `toPublicPlayer` at the top of convex/players.ts.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Mike Trout", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Mike Trout", sportId: baseball });

    expect(Object.keys(rows[0]).sort()).toEqual(["_id", "confidence", "name"]);
  });

  test("returns [] for a blank name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Mike Trout", baseball);

    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.players.nearMatches, { name: "   ", sportId: baseball }),
    ).toEqual([]);
  });

  // NEO-284 — the same OR-not-overwrite bug fixed in `teams.nearMatches`: the
  // search leg used to `candidates.set` unconditionally, so a row that had
  // already landed in the map via the exact/alias leg (carrying
  // `matchedAlias`) lost that field the moment the search leg ALSO matched
  // it. A row whose alias is the query AND whose primary name shares tokens
  // with the query hits both legs, so this seeds exactly that.
  test("an alias hit keeps its matchedAlias when the search leg also matches the same row", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const playerId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("players", {
        name: "Ron Artest Jr",
        nameNormalized: normalizePlayerName("Ron Artest Jr"),
        sportId: baseball,
        aliases: ["Ron Artest"],
        lastUpdated: 1_700_000_000_000,
      });
      await ctx.db.insert("playerAliases", {
        playerId: id,
        sportId: baseball,
        aliasNormalized: normalizePlayerName("Ron Artest"),
      });
      return id;
    });

    const rows = await t.withIdentity(ADMIN).query(api.players.nearMatches, {
      name: "Ron Artest",
      sportId: baseball,
    });

    const hit = rows.find((r) => r._id === playerId);
    expect(hit).toBeTruthy();
    expect(hit!.confidence).toBe("exact");
    expect(hit!.matchedAlias).toBe("Ron Artest");
  });

  test("is admin-gated", async () => {
    // Stricter than `players.search` next to it, deliberately: this query
    // exists to guard a write to globally-shared reference data, and its only
    // caller is admin tooling.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");

    await expect(
      t.query(api.players.nearMatches, { name: "Trout", sportId: baseball }),
    ).rejects.toThrow(/Not authenticated/);

    await expect(
      t
        .withIdentity(MEMBER)
        .query(api.players.nearMatches, { name: "Trout", sportId: baseball }),
    ).rejects.toThrow(/Admin access required/);
  });
});

// ---------------------------------------------------------------------------
// NEO-462 — each row's career line ("Dodgers 2014–19 · Brewers 2020–21 +1 more")
// ---------------------------------------------------------------------------

/**
 * Every span here is CLOSED: the handler counts an open stint through the
 * real current year (`new Date()`), and a fixture that depended on it would
 * re-rank itself as it aged. The ranking with an open stint is pinned
 * against a fixed year in `lib/players/player-description.test.ts`.
 */
describe("players.nearMatches — career (NEO-462)", () => {
  type Stint = { teamId: Id<"teams">; fromYear?: number; toYear?: number };

  async function seedTeam(
    t: ReturnType<typeof convexTest>,
    name: string,
    sportId: Id<"selectorOptions">,
  ): Promise<Id<"teams">> {
    return t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name,
        nameNormalized: name.toLowerCase(),
        sportId,
        lastUpdated: 1_700_000_000_000,
      }),
    );
  }

  async function seedPlayerWith(
    t: ReturnType<typeof convexTest>,
    name: string,
    sportId: Id<"selectorOptions">,
    extra: { birthYear?: number; teamYears?: Stint[] },
  ): Promise<Id<"players">> {
    return t.run(async (ctx) =>
      ctx.db.insert("players", {
        name,
        nameNormalized: normalizePlayerName(name),
        sportId,
        lastUpdated: 1_700_000_000_000,
        ...extra,
      }),
    );
  }

  test("ranks teams by summed seasons, shows two and counts the rest", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const dodgers = await seedTeam(t, "Dodgers", baseball);
    const brewers = await seedTeam(t, "Brewers", baseball);
    const padres = await seedTeam(t, "Padres", baseball);
    const walkerId = await seedPlayerWith(t, "Neil Walker", baseball, {
      birthYear: 1990,
      // Stored chronologically, as the write paths sort them; the line is
      // ranked by tenure instead: Dodgers 6, Brewers 2, Padres 1.
      teamYears: [
        { teamId: dodgers, fromYear: 2014, toYear: 2019 },
        { teamId: brewers, fromYear: 2020, toYear: 2021 },
        { teamId: padres, fromYear: 2022, toYear: 2022 },
      ],
    });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Neil Walker", sportId: baseball });

    expect(rows).toEqual([
      {
        _id: walkerId,
        name: "Neil Walker",
        confidence: "exact",
        birthYear: 1990,
        career: {
          teams: [
            { name: "Dodgers", spans: [{ fromYear: 2014, toYear: 2019 }] },
            { name: "Brewers", spans: [{ fromYear: 2020, toYear: 2021 }] },
          ],
          moreTeams: 1,
        },
      },
    ]);
  });

  test("keeps repeat stints at one team as separate spans and ranks them summed", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const mets = await seedTeam(t, "Mets", baseball);
    const cubs = await seedTeam(t, "Cubs", baseball);
    await seedPlayerWith(t, "Split Stint", baseball, {
      teamYears: [
        { teamId: mets, fromYear: 2001, toYear: 2001 },
        { teamId: mets, fromYear: 2003, toYear: 2003 },
        { teamId: cubs, fromYear: 2005, toYear: 2006 },
        { teamId: mets, fromYear: 2008, toYear: 2008 },
      ],
    });

    const [row] = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Split Stint", sportId: baseball });

    expect(row.career).toEqual({
      teams: [
        {
          name: "Mets",
          spans: [
            { fromYear: 2001, toYear: 2001 },
            { fromYear: 2003, toYear: 2003 },
            { fromYear: 2008, toYear: 2008 },
          ],
        },
        { name: "Cubs", spans: [{ fromYear: 2005, toYear: 2006 }] },
      ],
      moreTeams: 0,
    });
  });

  test("carries only team names and spans — no team id reaches the client", async () => {
    // Security review: the career line is display text. A team `_id` in it
    // would hand the client a key it has no other way to obtain here.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const teamIds = [
      await seedTeam(t, "Dodgers", baseball),
      await seedTeam(t, "Brewers", baseball),
      await seedTeam(t, "Padres", baseball),
    ];
    await seedPlayerWith(t, "Neil Walker", baseball, {
      teamYears: [
        { teamId: teamIds[0], fromYear: 2014, toYear: 2019 },
        { teamId: teamIds[1], fromYear: 2020, toYear: 2021 },
        { teamId: teamIds[2], fromYear: 2022, toYear: 2022 },
        { teamId: teamIds[2] },
      ],
    });

    const [row] = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Neil Walker", sportId: baseball });

    expect(Object.keys(row.career!).sort()).toEqual(["moreTeams", "teams"]);
    for (const team of row.career!.teams) {
      expect(Object.keys(team).sort()).toEqual(["name", "spans"]);
      for (const span of team.spans) {
        expect(Object.keys(span).every((k) => k === "fromYear" || k === "toYear")).toBe(true);
      }
    }
    const wire = JSON.stringify(row);
    for (const id of teamIds) expect(wire).not.toContain(id);
  });

  test("omits career for a player with no stints, and for an empty stint list", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayerWith(t, "Bob Allen", baseball, { birthYear: 1937 });
    await seedPlayerWith(t, "Bob Allen", baseball, { teamYears: [] });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Bob Allen", sportId: baseball });

    expect(rows).toHaveLength(2);
    for (const row of rows) expect("career" in row).toBe(false);
  });

  test("names an undated-only team (a college) bare, after the dated ones", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const wisconsin = await seedTeam(t, "Wisconsin", baseball);
    const brewers = await seedTeam(t, "Brewers", baseball);
    await seedPlayerWith(t, "Bucky Badger", baseball, {
      teamYears: [
        { teamId: wisconsin },
        { teamId: brewers, fromYear: 2020, toYear: 2020 },
      ],
    });

    const [row] = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Bucky Badger", sportId: baseball });

    expect(row.career).toEqual({
      teams: [
        { name: "Brewers", spans: [{ fromYear: 2020, toYear: 2020 }] },
        { name: "Wisconsin", spans: [] },
      ],
      moreTeams: 0,
    });
  });

  test("renders a dangling team id as 'Unknown team' rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const gone = await seedTeam(t, "Expos", baseball);
    await t.run(async (ctx) => ctx.db.delete(gone));
    await seedPlayerWith(t, "Ghost Expo", baseball, {
      teamYears: [{ teamId: gone, fromYear: 1995, toYear: 2004 }],
    });

    const [row] = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Ghost Expo", sportId: baseball });

    expect(row.career).toEqual({
      teams: [{ name: "Unknown team", spans: [{ fromYear: 1995, toYear: 2004 }] }],
      moreTeams: 0,
    });
  });

  /**
   * The read budget, pinned by counting `db.get` on the team ids. The public
   * query's ctx cannot be wrapped from outside, so the registered handler is
   * called directly with a counting proxy (the `_handler` precedent is
   * `fetchCardChecklist.teamFence.test.ts`; the proxy is
   * `players.alsoSportIds.test.ts`'s).
   */
  test("reads only shown teams, and a team two rows share once", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const mariners = await seedTeam(t, "Mariners", baseball);
    const reds = await seedTeam(t, "Reds", baseball);
    const unshown = await seedTeam(t, "Rays", baseball);
    const alsoUnshown = await seedTeam(t, "Twins", baseball);
    // Both Bob Allens' top team is Seattle; neither ever shows the Rays or
    // the Twins (one season each, ranked third and fourth).
    await seedPlayerWith(t, "Bob Allen", baseball, {
      teamYears: [
        { teamId: mariners, fromYear: 1990, toYear: 1999 },
        { teamId: reds, fromYear: 2000, toYear: 2004 },
        { teamId: unshown, fromYear: 2005, toYear: 2005 },
        { teamId: alsoUnshown, fromYear: 2006, toYear: 2006 },
      ],
    });
    await seedPlayerWith(t, "Bob Allen", baseball, {
      teamYears: [
        { teamId: mariners, fromYear: 1960, toYear: 1969 },
        { teamId: unshown, fromYear: 1970, toYear: 1970 },
        { teamId: reds, fromYear: 1971, toYear: 1972 },
      ],
    });

    const { teamReads, rows } = await t.withIdentity(ADMIN).run(async (ctx) => {
      const teamIds = new Set<string>([mariners, reds, unshown, alsoUnshown]);
      const teamReads: string[] = [];
      const db = new Proxy(ctx.db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "get" && typeof value === "function") {
            return (...args: unknown[]) => {
              const id = args[args.length - 1] as string;
              if (teamIds.has(id)) teamReads.push(id);
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (nearMatches as any)._handler(
        { ...ctx, db } as QueryCtx,
        { name: "Bob Allen", sportId: baseball },
      );
      return { teamReads, rows };
    });

    expect(rows).toHaveLength(2);
    // Seattle and Cincinnati once each, across both rows; never the unshown.
    expect([...teamReads].sort()).toEqual([mariners, reds].sort());
    for (const row of rows) {
      expect(row.career.teams.map((t: { name: string }) => t.name)).toEqual([
        "Mariners",
        "Reds",
      ]);
    }
    const moreTeams = rows.map((r: { career: { moreTeams: number } }) => r.career.moreTeams).sort();
    expect(moreTeams).toEqual([1, 2]);
  });
});
