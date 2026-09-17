/**
 * NEO-284 — the armed bulk upsert (`bulkLoad.ts`): the gate, the three-step
 * team match, alias union/ownership, era narrowing, dry run, and the league
 * gap-fill. See the module header on `bulkLoad.ts` for the protocol this
 * exercises; each `describe` below documents one clause of it.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { findTeamsByFullName } from "./lib/teamRow";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const CONFIRM = "BULK_LOAD" as const;
const ADMIN = { subject: "admin_bulk_load", role: "admin" };
type T = ReturnType<typeof convexTest>;

afterEach(() => vi.unstubAllEnvs());

/** Every armed test needs this; unarmed tests deliberately skip it. */
function armed() {
  vi.stubEnv("ALLOW_BULK_LOAD", "true");
}

async function seedSport(t: T, value = "Baseball") {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function seedTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  parts: {
    location?: string;
    name: string;
    years?: { from: number; to?: number };
    aliases?: string[];
    wikidataId?: string;
  },
) {
  const full = parts.location ? `${parts.location} ${parts.name}` : parts.name;
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("teams", {
      name: parts.name,
      ...(parts.location ? { location: parts.location } : {}),
      nameNormalized: normalizeTeamName(full),
      sportId,
      ...(parts.years ? { yearsActive: parts.years } : {}),
      ...(parts.aliases ? { aliases: parts.aliases } : {}),
      ...(parts.wikidataId ? { externalIds: { wikidataId: parts.wikidataId } } : {}),
      lastUpdated: 1_700_000_000_000,
    });
    for (const alias of parts.aliases ?? []) {
      await ctx.db.insert("teamAliases", {
        teamId: id,
        sportId,
        aliasNormalized: normalizeTeamName(alias),
      });
    }
    return id;
  });
}

const scheduledCount = (t: T) =>
  t.run(async (ctx) =>
    (
      ctx as unknown as {
        db: { system: { query: (n: string) => { collect: () => Promise<unknown[]> } } };
      }
    ).db.system.query("_scheduled_functions").collect(),
  );

describe("the gate", () => {
  test("upsertTeams unarmed (no ALLOW_BULK_LOAD) refuses even with the right confirm", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [{ key: "k", name: "Tigers" }],
      }),
    ).rejects.toThrow(/not armed/);
  });

  test("upsertLeagues unarmed refuses even with the right confirm", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.mutation(internal.bulkLoad.upsertLeagues, {
        confirm: CONFIRM,
        sport: "Baseball",
        leagues: [{ name: "NCAA" }],
      }),
    ).rejects.toThrow(/not armed/);
  });

  test("previewTeams needs no arming at all — it never writes", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);
    const preview = await t.query(internal.bulkLoad.previewTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "k", location: "LSU", name: "Tigers", aliases: ["LSU"] }],
    });
    expect(preview.results[0].status).toBe("would-create");
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(0);
  });

  test("armed but wrong confirm literal still throws (validator, not the flag)", async () => {
    armed();
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        // @ts-expect-error — deliberately wrong literal to prove the validator catches it
        confirm: "NOT_BULK_LOAD",
        sport: "Baseball",
        teams: [],
      }),
    ).rejects.toThrow();
  });

  test("previewTeams with the wrong confirm literal also throws", async () => {
    const t = convexTest(schema, modules);
    await seedSport(t);
    await expect(
      t.query(internal.bulkLoad.previewTeams, {
        // @ts-expect-error — deliberately wrong literal
        confirm: "NOT_BULK_LOAD",
        sport: "Baseball",
        teams: [],
      }),
    ).rejects.toThrow();
  });
});

describe("create writes aliases through the one index writer, no enrichment", () => {
  test("first run creates with aliases, teams.aliases + teamAliases both land, no scheduled work", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const row = {
      key: "Q1",
      location: "LSU",
      name: "Tigers",
      aliases: ["LSU", "Louisiana State University", "LSU Tigers baseball", "LSU Tigers"],
      league: "NCAA",
      wikidataId: "Q1",
    };
    const first = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [row],
    });
    expect(first.results[0].status).toBe("created");
    expect(first.leagues).toEqual([{ name: "NCAA", id: expect.any(String) }]);
    // No enrichment scheduled — see the "Nothing here schedules enrichment" header.
    expect(await scheduledCount(t)).toHaveLength(0);

    const team = await t.run(async (ctx) => ctx.db.get(first.results[0].id!));
    // "LSU Tigers" is the row's own full name and is dropped on the way in.
    expect(team!.aliases).toEqual(["LSU", "Louisiana State University", "LSU Tigers baseball"]);
    expect(team!.externalIds?.wikidataId).toBe("Q1");

    const index = await t.run(async (ctx) => ctx.db.query("teamAliases").collect());
    expect(index).toHaveLength(3);
  });

  test("create reports nearExisting: a fuzzy same-location neighbor worth a second look", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const rainbows = await seedTeam(t, sportId, { location: "Hawaii", name: "Rainbows" });

    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "hi", location: "Hawaii", name: "Rainbow Warriors" }],
    });
    expect(res.results[0].status).toBe("created");
    expect(res.results[0].nearExisting).toEqual([
      expect.objectContaining({ id: rainbows }),
    ]);
  });
});

describe("adopt-by-name gap-fills only absent fields, never touches name/location", () => {
  test("re-running the same row a second time adopts by name and converges (idempotent)", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const row = {
      key: "Q1",
      location: "LSU",
      name: "Tigers",
      aliases: ["LSU", "Louisiana State University"],
      league: "NCAA",
      wikidataId: "Q1",
    };
    await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [row],
    });

    const second = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [row],
    });
    expect(second.results[0]).toMatchObject({
      status: "adopted",
      matchedBy: "name",
      filled: [],
      aliasesAdded: 0,
    });
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });

  test("fills leagueId, yearsActive, wikidataId only when ABSENT; name/location never rewritten", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const bare = await seedTeam(t, sportId, { location: "Adelaide", name: "Giants" });

    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "g",
          location: "Adelaide",
          name: "Giants",
          league: "ABL",
          yearsActive: { from: 2009 },
          wikidataId: "Q42",
        },
      ],
    });
    expect(res.results[0]).toMatchObject({
      status: "adopted",
      matchedBy: "name",
      filled: expect.arrayContaining(["leagueId", "yearsActive", "wikidataId"]),
    });
    const team = await t.run(async (ctx) => ctx.db.get(bare));
    expect(team!.name).toBe("Giants");
    expect(team!.location).toBe("Adelaide");
    expect(team!.yearsActive).toEqual({ from: 2009 });
    expect(team!.externalIds?.wikidataId).toBe("Q42");
  });

  test("already-present fields are left alone on a second, differing row", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    // leagueId set too, so the sport's bootstrap-default league (Baseball →
    // MLB) has nothing left to fill and `filled` isolates the years/wikidata
    // behaviour this test is actually about.
    const leagueId = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Placeholder League",
        nameNormalized: "placeholder league",
        sportId,
        level: "other",
        lastUpdated: 1_700_000_000_000,
      }),
    );
    const dated = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Giants",
        location: "Adelaide",
        nameNormalized: normalizeTeamName("Adelaide Giants"),
        sportId,
        leagueId,
        yearsActive: { from: 2009 },
        externalIds: { wikidataId: "Q42" },
        lastUpdated: 1_700_000_000_000,
      }),
    );

    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "g",
          location: "Adelaide",
          name: "Giants",
          yearsActive: { from: 2009 },
          wikidataId: "Q999",
        },
      ],
    });
    expect(res.results[0]).toMatchObject({ status: "adopted", filled: [], wikidataMismatch: true });
    const team = await t.run(async (ctx) => ctx.db.get(dated));
    expect(team!.externalIds?.wikidataId).toBe("Q42");
  });
});

describe("adopt-by-alias, both directions, always reports a suggestion, never renames", () => {
  test("(a) a prod row named exactly the incoming LABEL is adopted through the label-as-alias leg", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const labelRow = await seedTeam(t, sportId, { name: "Washington Huskies baseball" });

    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "Q2",
          location: "Washington",
          name: "Huskies",
          aliases: ["Washington Huskies baseball", "UW Huskies", "University of Washington"],
          yearsActive: { from: 1901 },
          wikidataId: "Q2",
        },
      ],
    });
    expect(res.results[0]).toMatchObject({
      status: "adopted",
      id: labelRow,
      matchedBy: "alias",
      matchedOn: "Washington Huskies baseball",
      suggestion: { location: "Washington", name: "Huskies" },
      filled: expect.arrayContaining(["leagueId", "yearsActive", "wikidataId"]),
      // The two dataset aliases the row did not have, PLUS the incoming
      // canonical name — see the next test for why that one matters.
      aliasesAdded: 3,
    });
    const team = await t.run(async (ctx) => ctx.db.get(labelRow));
    // Never renamed.
    expect(team!.name).toBe("Washington Huskies baseball");
    expect(team!.location).toBeUndefined();
    expect(team!.aliases).toEqual([
      "Washington Huskies",
      "UW Huskies",
      "University of Washington",
    ]);
  });

  test("(c) rehearsal gap: adopt-by-alias adds the incoming CANONICAL name as an alias, so the checklist string resolves and the wizard offers Link", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const labelRow = await seedTeam(t, sportId, {
      location: "West Virginia",
      name: "Mountaineers baseball",
    });
    const row = {
      key: "wvu",
      location: "West Virginia",
      name: "Mountaineers",
      // The dataset's alias list never carries the canonical name itself.
      aliases: ["West Virginia Mountaineers baseball", "WVU", "West Virginia University"],
    };

    const first = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [row],
    });
    expect(first.results[0]).toMatchObject({
      status: "adopted",
      id: labelRow,
      matchedBy: "alias",
      aliasesAdded: 3,
    });
    const team = await t.run(async (ctx) => ctx.db.get(labelRow));
    expect(team!.name).toBe("Mountaineers baseball");
    expect(team!.aliases).toEqual(["West Virginia Mountaineers", "WVU", "West Virginia University"]);

    // The string a checklist prints now finds the row through the shared
    // lookup — this is acceptance 3 for a label-named prod row.
    expect(
      await t.run((ctx) => findTeamsByFullName(ctx, sportId, "West Virginia Mountaineers")),
    ).toHaveLength(1);
    // …and the wizard's near-match panel ranks it exact with the alias, which
    // is what flips its primary action from New Team to Link.
    const near = await t
      .withIdentity(ADMIN)
      .query(api.teams.nearMatches, { name: "West Virginia Mountaineers", sportId });
    expect(near).toEqual([
      {
        _id: labelRow,
        name: "West Virginia Mountaineers baseball",
        confidence: "exact",
        matchedAlias: "West Virginia Mountaineers",
      },
    ]);

    // Idempotent: the second run adopts through the alias it just wrote and
    // adds nothing.
    const second = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [row],
    });
    expect(second.results[0]).toMatchObject({ status: "adopted", id: labelRow, aliasesAdded: 0 });
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });

  test("(d) the double-row case: when another row's PRIMARY name IS the canonical name, it is skipped, not written", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    // Prod holds BOTH a split row and a label-named row for one program. A
    // replayed decision picks the label row; its canonical name belongs to
    // the other row and must not become an alias here.
    const split = await seedTeam(t, sportId, { location: "LSU", name: "Tigers" });
    const label = await seedTeam(t, sportId, { location: "LSU", name: "Tigers baseball" });

    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "lsu",
          location: "LSU",
          name: "Tigers",
          aliases: ["LSU Tigers baseball", "Louisiana State University"],
          decision: { adopt: label },
        },
      ],
    });
    expect(res.results[0]).toMatchObject({
      status: "adopted",
      id: label,
      matchedBy: "decision",
      aliasesAdded: 1,
      aliasesSkipped: [{ alias: "LSU Tigers", id: split, name: "LSU Tigers" }],
    });
    const team = await t.run(async (ctx) => ctx.db.get(label));
    expect(team!.aliases).toEqual(["Louisiana State University"]);
    // The split row still edits itself freely — no lock-out was created.
    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.saveTeamFields, { id: split, yearsActive: { from: 1893 } });
  });

  test("(b) a prod row that already carries the incoming NAME as an alias is adopted the other way", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    // Row's own primary name is "Aztecs"; it already carries "San Diego State"
    // as an alias, and the incoming row's full name is "San Diego State".
    const row = await seedTeam(t, sportId, {
      location: "San Diego State",
      name: "Aztecs",
      aliases: ["San Diego State"],
    });

    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "sdsu", name: "San Diego State", wikidataId: "Q77" }],
    });
    expect(res.results[0]).toMatchObject({
      status: "adopted",
      id: row,
      matchedBy: "alias",
      matchedOn: "San Diego State",
      suggestion: { name: "San Diego State" },
    });
    const team = await t.run(async (ctx) => ctx.db.get(row));
    expect(team!.name).toBe("Aztecs");
    expect(team!.location).toBe("San Diego State");
  });
});

describe("a bare shared alias is never enough to adopt on its own", () => {
  test("row found ONLY through a shared alias (not vouched by a primary-name match) is ambiguous", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const other = await seedTeam(t, sportId, { location: "Miami", name: "RedHawks", aliases: ["Miami"] });

    const row = { key: "Q3", location: "Miami", name: "Hurricanes", aliases: ["Miami", "Miami (FL)"] };
    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [row],
    });
    expect(res.results[0]).toMatchObject({
      status: "ambiguous",
      matchedOn: "Miami",
      candidates: [{ id: other, name: "RedHawks", location: "Miami", aliases: ["Miami"] }],
    });
    expect(res.results[0].aliasOwnedBy).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });

  test("decision.create after that converges: creates, skips the owned alias, still surfaces the neighbor", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const other = await seedTeam(t, sportId, { location: "Miami", name: "RedHawks", aliases: ["Miami"] });
    const row = { key: "Q3", location: "Miami", name: "Hurricanes", aliases: ["Miami", "Miami (FL)"] };

    const created = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ ...row, decision: { create: true as const } }],
    });
    expect(created.results[0]).toMatchObject({
      status: "created",
      aliasesSkipped: [{ alias: "Miami", id: other }],
    });
    const team = await t.run(async (ctx) => ctx.db.get(created.results[0].id!));
    expect(team!.aliases).toEqual(["Miami (FL)"]);
    expect(created.results[0].nearExisting).toEqual([
      expect.objectContaining({ id: other }),
    ]);
  });
});

describe("alias owned by a DIFFERENT row than the matched candidate", () => {
  test("owned alias on an otherwise clean name/alias match → ambiguous with aliasOwnedBy, nothing written", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const other = await seedTeam(t, sportId, { location: "Long Beach State", name: "49ers", aliases: ["LBSU"] });
    const dirtbags = await seedTeam(t, sportId, { location: "Long Beach State", name: "Dirtbags" });

    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "d", location: "Long Beach State", name: "Dirtbags", aliases: ["LBSU"] }],
    });
    expect(res.results[0]).toMatchObject({
      status: "ambiguous",
      candidates: [{ id: dirtbags }],
      aliasOwnedBy: [{ alias: "LBSU", id: other, name: "Long Beach State 49ers" }],
    });
    expect((await t.run(async (ctx) => ctx.db.get(dirtbags)))!.aliases).toBeUndefined();
  });

  test("decision.adopt on the same key converges: owned alias skipped, safe alias lands", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const other = await seedTeam(t, sportId, { location: "Long Beach State", name: "49ers", aliases: ["LBSU"] });
    const dirtbags = await seedTeam(t, sportId, { location: "Long Beach State", name: "Dirtbags" });

    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        {
          key: "d",
          location: "Long Beach State",
          name: "Dirtbags",
          aliases: ["LBSU", "The Dirtbags"],
          decision: { adopt: dirtbags },
        },
      ],
    });
    expect(res.results[0]).toMatchObject({
      status: "adopted",
      matchedBy: "decision",
      aliasesAdded: 1,
      aliasesSkipped: [{ alias: "LBSU", id: other }],
    });
    expect((await t.run(async (ctx) => ctx.db.get(dirtbags)))!.aliases).toEqual(["The Dirtbags"]);
  });

  test("adopt decision pointing at a team in ANOTHER sport is refused as 'not a team in this sport', nothing written", async () => {
    armed();
    const t = convexTest(schema, modules);
    await seedSport(t);
    const hockeyId = await seedSport(t, "Hockey");
    // Same name, wrong sport: the id-only check must not be satisfied by the
    // name matching, because a cross-sport adopt would gap-fill a hockey row
    // with a baseball program's league and Q-id.
    const hockeyRow = await seedTeam(t, hockeyId, { location: "LSU", name: "Tigers" });

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [{ key: "x", location: "LSU", name: "Tigers", decision: { adopt: hockeyRow } }],
      }),
    ).rejects.toThrow(/not a team in this sport/);
    const untouched = await t.run(async (ctx) => ctx.db.get(hockeyRow));
    expect(untouched!.leagueId).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });

  test("wrong-key adopt decision (chosen row answers to none of the incoming names) is refused", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const other = await seedTeam(t, sportId, { location: "Hawaii", name: "Rainbows" });

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [{ key: "x", location: "Hawaii", name: "Rainbow Warriors", decision: { adopt: other } }],
      }),
    ).rejects.toThrow(/different team/);
  });
});

describe("undated rival vs. a closed incoming era", () => {
  test("undated prod row + CLOSED incoming era → ambiguous (order-independence guard)", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedTeam(t, sportId, { location: "Adelaide", name: "Giants" });

    const closed = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "old", location: "Adelaide", name: "Giants", yearsActive: { from: 1989, to: 1999 } }],
    });
    expect(closed.results[0].status).toBe("ambiguous");
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });

  test("undated prod row + OPEN incoming era → adopts and fills years; a later closed era then creates fresh", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const giants = await seedTeam(t, sportId, { location: "Adelaide", name: "Giants" });

    const open = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "new", location: "Adelaide", name: "Giants", yearsActive: { from: 2009 } }],
    });
    expect(open.results[0]).toMatchObject({
      status: "adopted",
      id: giants,
      filled: expect.arrayContaining(["yearsActive"]),
    });

    // Now the row on file is dated 2009-, so a closed 1989-1999 era no longer
    // overlaps it at all: positive evidence of a NEW era, so it creates.
    const again = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [{ key: "old", location: "Adelaide", name: "Giants", yearsActive: { from: 1989, to: 1999 } }],
    });
    expect(again.results[0]).toMatchObject({ status: "created", nearExisting: [expect.objectContaining({ id: giants })] });
  });
});

describe("dry run and previewTeams write nothing and prefix their statuses with would-", () => {
  test("upsertTeams dryRun: would-create, no rows written, no scheduled work", async () => {
    armed();
    const t = convexTest(schema, modules);
    await seedSport(t);
    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      dryRun: true,
      teams: [{ key: "k", location: "LSU", name: "Tigers", aliases: ["LSU"] }],
    });
    expect(res.results[0].status).toBe("would-create");
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("teamAliases").collect())).toHaveLength(0);
    expect(await scheduledCount(t)).toHaveLength(0);
  });

  test("upsertTeams dryRun: would-adopt against an existing row, and that row is untouched", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const giants = await seedTeam(t, sportId, { location: "Adelaide", name: "Giants" });
    const res = await t.mutation(internal.bulkLoad.upsertTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      dryRun: true,
      teams: [{ key: "g", location: "Adelaide", name: "Giants", yearsActive: { from: 2009 } }],
    });
    expect(res.results[0]).toMatchObject({ status: "would-adopt", id: giants });
    expect((await t.run(async (ctx) => ctx.db.get(giants)))!.yearsActive).toBeUndefined();
  });

  test("previewTeams (the read-only query) matches would-create/would-adopt and writes nothing, unarmed", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const giants = await seedTeam(t, sportId, { location: "Adelaide", name: "Giants" });
    const preview = await t.query(internal.bulkLoad.previewTeams, {
      confirm: CONFIRM,
      sport: "Baseball",
      teams: [
        { key: "g", location: "Adelaide", name: "Giants" },
        { key: "new", location: "LSU", name: "Tigers" },
      ],
    });
    expect(preview.results.map((r) => r.status)).toEqual(["would-adopt", "would-create"]);
    expect(preview.results[0].id).toBe(giants);
    expect(await t.run(async (ctx) => ctx.db.query("teams").collect())).toHaveLength(1);
  });
});

describe("an alias union that would push an ADOPT past MAX_TEAM_ALIASES (64) is refused", () => {
  test("throws rather than silently truncating", async () => {
    armed();
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    // 63 existing aliases already on the row.
    const existingAliases = Array.from({ length: 63 }, (_, i) => `Alias ${i}`);
    const bulldogs = await seedTeam(t, sportId, {
      location: "Georgia",
      name: "Bulldogs",
      aliases: existingAliases,
    });

    await expect(
      t.mutation(internal.bulkLoad.upsertTeams, {
        confirm: CONFIRM,
        sport: "Baseball",
        teams: [
          {
            key: "uga",
            location: "Georgia",
            name: "Bulldogs",
            // Two brand-new aliases push 63 + 2 = 65 past the 64 cap.
            aliases: ["New Alias One", "New Alias Two"],
          },
        ],
      }),
    ).rejects.toThrow(/64/);
    // Refused before any patch — the row is untouched.
    expect((await t.run(async (ctx) => ctx.db.get(bulldogs)))!.aliases).toHaveLength(63);
  });
});

describe("upsertLeagues", () => {
  test("creates, reports created: true, and schedules no enrichment", async () => {
    armed();
    const t = convexTest(schema, modules);
    await seedSport(t);
    const res = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [
        {
          name: "Australian Baseball League",
          abbreviation: "ABL",
          level: "other",
          yearsActive: { from: 2009 },
          aliases: ["ABL"],
          wikidataId: "Q1045441",
        },
      ],
    });
    expect(res.results[0].created).toBe(true);
    expect(await scheduledCount(t)).toHaveLength(0);
  });

  test("dryRun resolves an existing alias to the found row and reports a new name as created: true, unwritten", async () => {
    armed();
    const t = convexTest(schema, modules);
    await seedSport(t);
    const created = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Australian Baseball League", aliases: ["ABL"] }],
    });

    const preview = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      dryRun: true,
      leagues: [{ name: "ABL" }, { name: "Australian Baseball League (1989-1999)" }],
    });
    expect(preview.results).toEqual([
      { name: "ABL", id: created.results[0].id, created: false },
      { name: "Australian Baseball League (1989-1999)", id: null, created: true },
    ]);
  });

  test("gap-fills aliases only on a found row that CURRENTLY HAS NONE — verified against source", async () => {
    armed();
    const t = convexTest(schema, modules);
    await seedSport(t);
    // First call creates the league with no aliases at all.
    const first = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Australian Baseball League" }],
    });
    expect(first.results[0].created).toBe(true);

    // Second call finds it (by name) and, because it currently carries NO
    // aliases, gap-fills the dataset's list wholesale.
    const second = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Australian Baseball League", aliases: ["ABL", "Aussie League"] }],
    });
    expect(second.results[0]).toMatchObject({ id: first.results[0].id, created: false });
    const league = await t.run(async (ctx) => ctx.db.get(first.results[0].id!));
    expect(league!.aliases).toEqual(["ABL", "Aussie League"]);

    // Third call: the row now has aliases, so a THIRD alias is NOT appended —
    // `bulkLoad.ts`'s comment says the helper "deliberately never widens an
    // existing row's aliases" and this file's own gap-fill only fires when
    // `(before.aliases ?? []).length === 0`, i.e. it never appends to a row
    // that already has some.
    const third = await t.mutation(internal.bulkLoad.upsertLeagues, {
      confirm: CONFIRM,
      sport: "Baseball",
      leagues: [{ name: "Australian Baseball League", aliases: ["ABL", "Aussie League", "ABLbb"] }],
    });
    expect(third.results[0]).toMatchObject({ id: first.results[0].id, created: false });
    const leagueAfter = await t.run(async (ctx) => ctx.db.get(first.results[0].id!));
    expect(leagueAfter!.aliases).toEqual(["ABL", "Aussie League"]);
  });
});
