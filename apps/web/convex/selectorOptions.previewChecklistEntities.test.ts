/**
 * NEO-339 — `selectorOptions.previewChecklistEntities`, the review gate's
 * verdict on a draft's names without a review batch.
 *
 * Pinned here:
 *   - it writes nothing (every table compared before and after) and starts
 *     no batch;
 *   - its known/unknown split is exactly the one `resolveChecklistEntities`
 *     reaches on the same names (one shared classifier);
 *   - an ambiguous name is unknown WITH its candidates, never linked to the
 *     first one; a name nobody holds is unknown with none;
 *   - NEO-212 skip records on the row are honoured;
 *   - the name count is bounded and the sport must be the row's own.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { PREVIEW_ENTITY_NAMES_PER_CALL } from "./selectorOptions";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo339_entities",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo339_entities",
  name: "Admin",
  role: "admin",
};
const SIGNED_IN = { subject: "user_neo339_entities" };
const T = 1_700_000_000_000;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: T,
    });
    const otherSportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      sportConfig: { skuCode: "HK", league: "NHL" },
      platformData: {},
      children: [],
      lastUpdated: T,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2021",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: T,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Heritage",
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: T,
    });
    const rowId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      metadata: { isBase: true },
      parentId: setId,
      children: [],
      lastUpdated: T,
    });
    const player = (name: string, birthYear?: number) =>
      ctx.db.insert("players", {
        sportId,
        name,
        nameNormalized: normalizePlayerName(name),
        ...(birthYear ? { birthYear } : {}),
        lastUpdated: T,
      });
    const knownId = await player("Known Player");
    const twinA = await player("Twin Name", 1950);
    const twinB = await player("Twin Name", 1990);
    const team = (location: string, name: string, from?: number, to?: number) =>
      ctx.db.insert("teams", {
        location,
        name,
        nameNormalized: normalizeTeamName(`${location} ${name}`),
        sportId,
        ...(from !== undefined
          ? { yearsActive: { from, ...(to !== undefined ? { to } : {}) } }
          : {}),
        lastUpdated: T,
      });
    const redSoxId = await team("Boston", "Red Sox");
    await team("Winnipeg", "Jets", 1972, 1996);
    const jets2011 = await team("Winnipeg", "Jets", 2011);
    await ctx.db.insert("entityReviewSkips", {
      selectorOptionId: rowId,
      kind: "player",
      nameNormalized: normalizePlayerName("CHECKLIST"),
      name: "CHECKLIST",
      skippedAt: T,
      skippedByUserId: ADMIN.subject,
    });
    return {
      sportId,
      otherSportId,
      setId,
      rowId,
      knownId,
      twins: [twinA, twinB],
      redSoxId,
      jets2011,
    };
  });
}

async function snapshotAll(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables)) {
      out[table] = await ctx.db.query(table as "selectorOptions").collect();
    }
    return out;
  });
}

const PLAYERS = ["Known Player", "Twin Name", "New Guy", "CHECKLIST", "known player"];
const TEAMS = ["Boston Red Sox", "Winnipeg Jets", "Nowhere Nine"];

describe("previewChecklistEntities", () => {
  test("refuses a signed-in non-admin", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seed(t);
    await expect(
      t.withIdentity(SIGNED_IN).query(api.selectorOptions.previewChecklistEntities, {
        sportId,
        players: ["Known Player"],
        teams: [],
      }),
    ).rejects.toThrow(/Admin access required/);
  });

  test("classifies by the review gate's rule, honours skips, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const before = await snapshotAll(t);

    const res = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.previewChecklistEntities, {
        sportId: s.sportId,
        selectorOptionId: s.rowId,
        players: PLAYERS,
        teams: TEAMS,
      });

    expect(await snapshotAll(t)).toEqual(before);
    expect(res.setYear).toBe(2021);
    // Deduped by normalized name, first spelling kept.
    expect(res.players.map((p) => [p.name, p.status, p.matchCount])).toEqual([
      ["Known Player", "known", 1],
      ["Twin Name", "unknown", 2],
      ["New Guy", "unknown", 0],
      ["CHECKLIST", "skipped", 0],
    ]);
    expect(res.players[0].playerId).toBe(s.knownId);
    // Ambiguous: unknown, both rows offered, neither picked.
    expect(res.players[1].playerId).toBeUndefined();
    expect(res.players[1].candidates.map((c) => c.playerId).sort()).toEqual(
      [...s.twins].sort(),
    );
    expect(res.players[2].candidates).toEqual([]);

    expect(res.teams.map((x) => [x.name, x.status])).toEqual([
      ["Boston Red Sox", "known"],
      ["Winnipeg Jets", "known"],
      ["Nowhere Nine", "unknown"],
    ]);
    expect(res.teams[0].teamId).toBe(s.redSoxId);
    // The set's year picks the era, as the review gate does.
    expect(res.teams[1].teamId).toBe(s.jets2011);
    expect(res.teams[1].candidates).toHaveLength(2);
    expect(res.teams[2].candidates).toEqual([]);
  });

  test("its unknowns are exactly the ones resolveChecklistEntities queues", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const preview = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.previewChecklistEntities, {
        sportId: s.sportId,
        selectorOptionId: s.rowId,
        players: PLAYERS,
        teams: TEAMS,
      });
    const staged = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.resolveChecklistEntities, {
        selectorOptionId: s.rowId,
        sportId: s.sportId,
        cards: [
          {
            cardNumber: "1",
            cardName: "One",
            players: PLAYERS.slice(0, 3),
            teams: TEAMS,
            platformData: {},
          },
          {
            cardNumber: "2",
            cardName: "Two",
            players: PLAYERS.slice(3),
            platformData: {},
          },
        ],
      });
    expect(staged.unknownPlayers).toEqual(["Twin Name", "New Guy"]);
    expect(staged.unknownTeams).toEqual(["Nowhere Nine"]);
    expect(
      preview.players.filter((p) => p.status === "unknown").map((p) => p.name),
    ).toEqual(staged.unknownPlayers);
    expect(
      preview.teams.filter((x) => x.status === "unknown").map((x) => x.name),
    ).toEqual(staged.unknownTeams);
  });

  test("without a row there are no skips and no year to narrow by", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.previewChecklistEntities, {
        sportId: s.sportId,
        players: ["CHECKLIST"],
        teams: ["Winnipeg Jets"],
      });
    expect(res.setYear).toBeNull();
    expect(res.players[0].status).toBe("unknown");
    // Two eras and no year: a human decides.
    expect(res.teams[0].status).toBe("unknown");
    expect(res.teams[0].candidates).toHaveLength(2);
  });

  test("a set id scopes the year for a row that does not exist yet", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.previewChecklistEntities, {
        sportId: s.sportId,
        selectorOptionId: s.setId,
        players: [],
        teams: ["Winnipeg Jets"],
      });
    expect(res.setYear).toBe(2021);
    expect(res.teams[0].teamId).toBe(s.jets2011);
  });

  test("refuses more names than one call may classify", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seed(t);
    await expect(
      t.withIdentity(ADMIN).query(api.selectorOptions.previewChecklistEntities, {
        sportId,
        players: Array.from(
          { length: PREVIEW_ENTITY_NAMES_PER_CALL },
          (_, i) => `Player ${i}`,
        ),
        teams: ["One More"],
      }),
    ).rejects.toThrow(/slice them/);
  });

  test("refuses a sport that is not the row's own", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      t.withIdentity(ADMIN).query(api.selectorOptions.previewChecklistEntities, {
        sportId: s.otherSportId,
        selectorOptionId: s.rowId,
        players: ["Known Player"],
        teams: [],
      }),
    ).rejects.toThrow(/sport ancestor/);
    await expect(
      t.withIdentity(ADMIN).query(api.selectorOptions.previewChecklistEntities, {
        sportId: s.rowId as Id<"selectorOptions">,
        players: ["Known Player"],
        teams: [],
      }),
    ).rejects.toThrow(/not a sport row/);
  });
});
