/**
 * NEO-424 — the review gate's use of set history, the Hall of Fame tie-break
 * and the rule-E preselects, driven through the real action
 * (`selectorOptions.resolveChecklistEntities`) and the real internal queries.
 *
 * `setHistory.test.ts` holds the pure verdict and the first end-to-end
 * cross-sport case; this file holds the rest of the gate's decision table:
 *
 *   - D3: history and the in-sport lookup agree → silent; differ → a row,
 *     history wins; two history players → a pick step.
 *   - What counts as history (insert and parallel cards, legacy cards, the
 *     PRINTED name rather than the player's own, committed cards only).
 *   - Rule F: a team the card prints that a history team answers to.
 *   - Rule E1 / E2 preselects and their ranking.
 *   - The incomplete-scan fallback and `historyCardBatch`'s slicing.
 *
 * The scan's reads are bounded `internalQuery` calls; `scanSetHistory` takes
 * an `ActionCtx`, which these tests stand in for with a `runQuery` that calls
 * `t.query`, so the REAL queries run against the in-memory database.
 */

import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import {
  NAMESAKE_NAMES_PER_CALL,
  SET_HISTORY_CARDS_PER_CALL,
  SET_HISTORY_MAX_CALLS,
  SET_HISTORY_MAX_NODES,
  SET_HISTORY_NODES_PER_CALL,
  scanSetHistory,
} from "./setHistory";
import { cancelScheduled } from "../lib/testing/drain-scheduled";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_history_gate_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_history_gate_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;
type Sel = Id<"selectorOptions">;

/** Every instance made here is cancelled at the end: gate batches schedule pool work. */
const live: T[] = [];
function newT(): T {
  const t = convexTest(schema, modules);
  live.push(t);
  return t;
}
afterEach(async () => {
  for (const t of live.splice(0)) await cancelScheduled(t);
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function node(
  t: T,
  fields: { level: string; value: string; parentId?: Sel },
): Promise<Sel> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      ...fields,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    if (fields.parentId) {
      const parent = await ctx.db.get(fields.parentId);
      await ctx.db.patch(fields.parentId, {
        children: [...(parent?.children ?? []), id],
      });
    }
    return id;
  });
}

const sport = (t: T, value: string) => node(t, { level: "sport", value });

/** year › manufacturer › setName, with a Base and an Insert variant type. */
async function product(
  t: T,
  sportId: Sel,
  opts: { year: string; brand?: string; set?: string },
) {
  const year = await node(t, { level: "year", value: opts.year, parentId: sportId });
  const brand = await node(t, {
    level: "manufacturer",
    value: opts.brand ?? "Topps",
    parentId: year,
  });
  const set = await node(t, {
    level: "setName",
    value: opts.set ?? "Series 1",
    parentId: brand,
  });
  const base = await node(t, { level: "variantType", value: "Base", parentId: set });
  const insert = await node(t, { level: "variantType", value: "Insert", parentId: set });
  return { year, brand, set, base, insert };
}

async function player(
  t: T,
  sportId: Sel,
  name: string,
  extra: Partial<Doc<"players">> = {},
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: Date.now(),
      ...extra,
    }),
  );
}

async function team(
  t: T,
  sportId: Sel,
  location: string,
  name: string,
  aliases?: string[],
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      location,
      name,
      nameNormalized: normalizeTeamName(`${location} ${name}`),
      sportId,
      ...(aliases ? { aliases } : {}),
      lastUpdated: Date.now(),
    }),
  );
}

/** A committed card. `printed` pairs the string the card carried with its player. */
async function committed(
  t: T,
  selectorOptionId: Sel,
  cardNumber: string,
  opts: {
    printed?: Array<[nameOnCard: string, playerId: Id<"players">]>;
    legacyPlayerIds?: Array<Id<"players">>;
    teamIds?: Array<Id<"teams">>;
  },
) {
  await t.run(async (ctx) =>
    insertTestCard(ctx, {
      selectorOptionId,
      cardNumber,
      cardName: "Card",
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
      ...(opts.printed
        ? {
            playerIds: opts.printed.map(([, id]) => id),
            playerLinks: opts.printed.map(([nameOnCard, playerId]) => ({
              playerId,
              nameOnCard,
            })),
          }
        : {}),
      ...(opts.legacyPlayerIds ? { playerIds: opts.legacyPlayerIds } : {}),
      ...(opts.teamIds ? { teamOnCardIds: opts.teamIds } : {}),
    }),
  );
}

function fetchedCard(players: string[], teams: string[] = [], cardNumber = "I-1") {
  return { cardNumber, cardName: "Card", players, teams, platformData: {} };
}

async function gate(
  t: T,
  selectorOptionId: Sel,
  sportId: Sel,
  players: string[],
  teams: string[] = [],
) {
  return t.withIdentity(ADMIN_IDENTITY).action(
    api.selectorOptions.resolveChecklistEntities,
    { selectorOptionId, sportId, cards: [fetchedCard(players, teams)] },
  );
}

async function rowsOf(t: T, batchId: string | undefined) {
  if (!batchId) return [];
  return (await t.run((ctx) => ctx.db.query("entityReviewQueue").collect())).filter(
    (row) => row.batchId === batchId,
  );
}

/** `runQuery` straight onto the real internal queries, for `scanSetHistory`. */
function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: never, args: never) => t.query(ref, args),
  } as unknown as ActionCtx;
}

// ─── D3 and the verdict at the gate ─────────────────────────────────────────

describe("the gate: set history against today's in-sport lookup (D3)", () => {
  test("history naming the player the lookup also finds is silent: no row, no batch", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, baseball, "Bo Jackson");
    await committed(t, p.base, "1", { printed: [["Bo Jackson", bo]] });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect(result.unknownPlayers).toEqual([]);
    expect(result.batchId).toBeUndefined();
  });

  test("history naming a different player than the lookup is a visible row, history first", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const boFootball = await player(t, football, "Bo Jackson");
    const boBaseball = await player(t, baseball, "Bo Jackson");
    await committed(t, p.base, "1", { printed: [["Bo Jackson", boFootball]] });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect(result.unknownPlayers).toEqual([]);
    const [row] = await rowsOf(t, result.batchId);
    expect(row).toMatchObject({
      kind: "player",
      sportId: football,
      status: "ready",
      decision: { action: "link", linkedPlayerId: boFootball, autoLinked: "setHistory" },
    });
    expect(row.decision).not.toHaveProperty("addSetSport");
    expect(row.enrichment?.existingCandidates?.map((c) => [c.playerId, c.sportValue])).toEqual([
      [boFootball, "Football"],
      [boBaseball, "Baseball"],
    ]);
  });

  test("history resolves a name the lookup could not (two in-sport namesakes)", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const a = await player(t, baseball, "Bob Allen", { birthYear: 1867 });
    const b = await player(t, baseball, "Bob Allen", { birthYear: 1937 });
    await committed(t, p.base, "1", { printed: [["Bob Allen", b]] });

    const result = await gate(t, p.insert, baseball, ["Bob Allen"]);

    // Not an unknown, and not a pick step: the set already said which.
    expect(result.unknownPlayers).toEqual([]);
    expect(result.ambiguousPlayers).toEqual([]);
    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toMatchObject({ linkedPlayerId: b, autoLinked: "setHistory" });
    expect(row.enrichment?.existingCandidates?.map((c) => c.playerId)).toEqual([b, a]);
  });

  test("two players linked under one name is a pick between exactly those, never looked up", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const one = await player(t, football, "Bo Jackson");
    const two = await player(t, baseball, "Bo Jackson");
    const outsider = await player(t, baseball, "Bo Jackson");
    await committed(t, p.base, "1", { printed: [["Bo Jackson", one]] });
    await committed(t, p.base, "2", { printed: [["Bo Jackson", two]] });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect(result.unknownPlayers).toEqual(["Bo Jackson"]);
    expect(result.ambiguousPlayers).toEqual(["Bo Jackson"]);
    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toBeUndefined();
    expect(row.status).toBe("ready");
    const ids = (row.enrichment?.existingCandidates ?? []).map((c) => c.playerId).sort();
    expect(ids).toEqual([one, two].sort());
    expect(ids).not.toContain(outsider);
    const enqueued = await t.run(async (ctx) =>
      (await (ctx as unknown as {
        db: { system: { query: (n: string) => { collect: () => Promise<Array<{ name: string }>> } } };
      }).db.system.query("_scheduled_functions").collect()).filter((r) =>
        r.name.includes("enqueueEntityReviewLookups"),
      ),
    );
    expect(enqueued).toHaveLength(0);
  });

  test("a name the set never linked is today's path, untouched", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const other = await player(t, baseball, "Mike Trout");
    await committed(t, p.base, "1", { printed: [["Mike Trout", other]] });

    const result = await gate(t, p.insert, baseball, ["Ken Griffey Jr."]);

    expect(result.unknownPlayers).toEqual(["Ken Griffey Jr."]);
    const [row] = await rowsOf(t, result.batchId);
    expect(row.status).toBe("pending");
    expect(row.decision).toBeUndefined();
  });
});

describe("the gate: what counts as set history", () => {
  test("a name linked on a PARALLEL card of the set counts", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const gold = await node(t, { level: "parallel", value: "Gold", parentId: p.insert });
    const bo = await player(t, football, "Bo Jackson");
    await committed(t, gold, "1", { printed: [["Bo Jackson", bo]] });

    const result = await gate(t, p.base, baseball, ["Bo Jackson"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toMatchObject({ linkedPlayerId: bo, autoLinked: "setHistory" });
  });

  test("history keys a linked player on the PRINTED name, his primary name and his aliases", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    // Cross-sport, so no in-sport lookup can answer either name: only the
    // set's history can.
    const vincent = await player(t, football, "Vincent Jackson", {
      aliases: ["Bo Jackson"],
    });
    await committed(t, p.base, "1", { printed: [["Bo Jackson", vincent]] });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson", "Vincent Jackson"]);

    const rows = await rowsOf(t, result.batchId);
    expect(rows.map((r) => r.name).sort()).toEqual(["Bo Jackson", "Vincent Jackson"]);
    for (const row of rows) {
      expect(row.sportId).toBe(football);
      expect(row.decision).toMatchObject({
        action: "link",
        linkedPlayerId: vincent,
        autoLinked: "setHistory",
      });
    }
    expect(result.unknownPlayers).toEqual([]);
  });

  test("an ALIAS the set never printed still names the linked player", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const vincent = await player(t, football, "Vincent Jackson", {
      aliases: ["Bo Jackson"],
    });
    await committed(t, p.base, "1", { printed: [["Vincent Jackson", vincent]] });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0]?.decision).toMatchObject({
      linkedPlayerId: vincent,
      autoLinked: "setHistory",
    });
  });

  test("two linked players answering to one name (printed for one, alias of the other) is a pick", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, football, "Bo Jackson");
    const vincent = await player(t, football, "Vincent Jackson", {
      aliases: ["Bo Jackson"],
    });
    await committed(t, p.base, "1", { printed: [["Bo Jackson", bo]] });
    await committed(t, p.base, "2", { printed: [["Vincent Jackson", vincent]] });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toBeUndefined();
    expect(
      (row.enrichment?.existingCandidates ?? []).map((c) => c.playerId).sort(),
    ).toEqual([bo, vincent].sort());
    expect(result.ambiguousPlayers).toEqual(["Bo Jackson"]);
  });

  test("a legacy card with playerIds and no playerLinks is keyed by the player's own name", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, football, "Bo Jackson");
    await player(t, baseball, "Bo Jackson");
    await committed(t, p.base, "1", { legacyPlayerIds: [bo] });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0]?.decision).toMatchObject({
      linkedPlayerId: bo,
      autoLinked: "setHistory",
    });
  });

  test("a card with several players keys each printed name on its own", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, football, "Bo Jackson");
    const deion = await player(t, football, "Deion Sanders");
    await player(t, baseball, "Bo Jackson");
    await committed(t, p.base, "1", {
      printed: [
        ["Bo Jackson", bo],
        ["Deion Sanders", deion],
      ],
    });

    const result = await gate(t, p.insert, baseball, ["Deion Sanders"]);

    const rows = await rowsOf(t, result.batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Deion Sanders");
    expect(rows[0].decision).toMatchObject({ linkedPlayerId: deion });
  });

  test("word order and punctuation do not hide history: 'Jackson, Bo' is 'Bo Jackson'", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, football, "Bo Jackson");
    await player(t, baseball, "Bo Jackson");
    await committed(t, p.base, "1", { printed: [["Jackson, Bo", bo]] });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0]?.decision).toMatchObject({
      linkedPlayerId: bo,
    });
  });

  test("diacritics: a card that printed 'José Ramírez' is the answer for 'Jose Ramirez'", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const jose = await player(t, football, "José Ramírez");
    await player(t, baseball, "Jose Ramirez");
    expect(normalizePlayerName("José Ramírez")).toBe(normalizePlayerName("Jose Ramirez"));
    await committed(t, p.base, "1", { printed: [["José Ramírez", jose]] });

    const result = await gate(t, p.insert, baseball, ["Jose Ramirez"]);

    expect((await rowsOf(t, result.batchId))[0]?.decision).toMatchObject({
      linkedPlayerId: jose,
    });
  });

  test("a player deleted since the card was committed cannot be linked: the name is an ordinary row", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const gone = await player(t, football, "Bo Jackson");
    await committed(t, p.base, "1", { printed: [["Bo Jackson", gone]] });
    await t.run((ctx) => ctx.db.delete(gone));

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect(result.unknownPlayers).toEqual(["Bo Jackson"]);
    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toBeUndefined();
    expect(row.sportId).toBe(baseball);
  });

  test("a sibling parallel's cards are history", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const gold = await node(t, { level: "parallel", value: "Gold", parentId: p.insert });
    const blue = await node(t, { level: "parallel", value: "Blue", parentId: p.insert });
    const bo = await player(t, football, "Bo Jackson");
    await player(t, baseball, "Bo Jackson");
    await committed(t, gold, "1", { printed: [["Bo Jackson", bo]] });

    // Fetching Blue: Gold is another variant's earlier answer.
    const sibling = await gate(t, blue, baseball, ["Bo Jackson"]);
    expect((await rowsOf(t, sibling.batchId))[0]?.decision).toMatchObject({
      linkedPlayerId: bo,
    });
  });
});

// ─── Hall of Fame at the gate ───────────────────────────────────────────────

describe("the gate: Hall of Fame (rule D) is a visible link, and history outranks it", () => {
  async function thomases(t: T, baseball: Sel) {
    const sox = await team(t, baseball, "Chicago", "White Sox");
    const pirates = await team(t, baseball, "Pittsburgh", "Pirates");
    const legend = await player(t, baseball, "Frank Thomas", {
      teamYears: [{ teamId: sox, fromYear: 1990, toYear: 2008 }],
      isHallOfFame: true,
    });
    const other = await player(t, baseball, "Frank Thomas", {
      teamYears: [{ teamId: pirates, fromYear: 1951, toYear: 1966 }],
    });
    return { legend, other };
  }

  test("a legend on a modern card is a decided row tagged hallOfFame, with the rival as Change's candidate", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const { legend, other } = await thomases(t, baseball);

    const result = await gate(t, p.insert, baseball, ["Frank Thomas"]);

    expect(result.unknownPlayers).toEqual([]);
    const [row] = await rowsOf(t, result.batchId);
    expect(row).toMatchObject({
      sportId: baseball,
      decision: { action: "link", linkedPlayerId: legend, autoLinked: "hallOfFame" },
    });
    expect(row.enrichment?.existingCandidates?.map((c) => c.playerId)).toEqual([legend, other]);
  });

  test("when history names the same Hall of Famer the name is silent", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const { legend } = await thomases(t, baseball);
    await committed(t, p.base, "1", { printed: [["Frank Thomas", legend]] });

    const result = await gate(t, p.insert, baseball, ["Frank Thomas"]);

    expect(result.unknownPlayers).toEqual([]);
    expect(result.batchId).toBeUndefined();
  });

  test("when history names the OTHER man, history wins over the Hall of Famer", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const { other } = await thomases(t, baseball);
    await committed(t, p.base, "1", { printed: [["Frank Thomas", other]] });

    const result = await gate(t, p.insert, baseball, ["Frank Thomas"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toMatchObject({ linkedPlayerId: other, autoLinked: "setHistory" });
  });

  // NEO-490 — before rule 6b this name was a pick step. The card names the
  // Pirates and only the rival has a Pirates stint (the legend has a career on
  // file that does not), so the card's team picks the rival: the Hall of Famer
  // is still kept out, and the answer is a VISIBLE careerTeam row the operator
  // can Change, the legend offered beside him.
  test("a card naming the rival's team keeps the legend out: the rival is a decided careerTeam row", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const { legend, other } = await thomases(t, baseball);

    const result = await t.withIdentity(ADMIN_IDENTITY).action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: p.insert,
        sportId: baseball,
        cards: [fetchedCard(["Frank Thomas"], ["Pittsburgh Pirates"])],
      },
    );

    expect(result.unknownPlayers).toEqual([]);
    expect(result.ambiguousPlayers).toEqual([]);
    expect(result.autoLinkedCount).toBe(1);
    const rows = (await rowsOf(t, result.batchId)).filter((r) => r.kind === "player");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sportId: baseball,
      decision: { action: "link", linkedPlayerId: other, autoLinked: "careerTeam" },
    });
    expect(rows[0].enrichment?.existingCandidates?.map((c) => c.playerId)).toEqual([other, legend]);
  });
});

// ─── Rule F: teams ──────────────────────────────────────────────────────────

describe("the gate: a printed team name that set history answers (rule F)", () => {
  test("a team on a committed card answers the printed name, in the team's own sport", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const raiders = await team(t, football, "Oakland", "Raiders");
    await committed(t, p.base, "1", { teamIds: [raiders] });

    const result = await gate(t, p.insert, baseball, [], ["Oakland Raiders"]);

    expect(result.unknownTeams).toEqual([]);
    const [row] = await rowsOf(t, result.batchId);
    expect(row).toMatchObject({
      kind: "team",
      sportId: football,
      status: "ready",
      decision: { action: "link", linkedTeamId: raiders, autoLinked: "setHistory" },
    });
  });

  test("the bare nickname and an alias answer too", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const raiders = await team(t, football, "Oakland", "Raiders", ["LA Raiders"]);
    await committed(t, p.base, "1", { teamIds: [raiders] });

    const nick = await gate(t, p.insert, baseball, [], ["Raiders"]);
    expect((await rowsOf(t, nick.batchId))[0]?.decision).toMatchObject({
      linkedTeamId: raiders,
    });
    const alias = await gate(t, p.insert, baseball, [], ["LA Raiders"]);
    expect((await rowsOf(t, alias.batchId)).some((r) => r.decision?.action === "link")).toBe(true);
  });

  test("two history teams answering to one printed name leave it unknown", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const nyg = await team(t, football, "New York", "Giants");
    const sfg = await team(t, baseball, "San Francisco", "Giants");
    await committed(t, p.base, "1", { teamIds: [nyg, sfg] });

    const result = await gate(t, p.insert, baseball, [], ["Giants"]);

    expect(result.unknownTeams).toEqual(["Giants"]);
    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toBeUndefined();
  });

  test("a team is never derived from a player's history: a history player's team is not a printed name", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const raiders = await team(t, football, "Oakland", "Raiders");
    const bo = await player(t, football, "Bo Jackson", {
      teamYears: [{ teamId: raiders, fromYear: 1987, toYear: 1990 }],
    });
    await committed(t, p.base, "1", { printed: [["Bo Jackson", bo]] });

    const result = await gate(t, p.insert, baseball, [], ["Oakland Raiders"]);

    expect(result.unknownTeams).toEqual(["Oakland Raiders"]);
  });
});

// ─── D4: the client is told about a batch of auto-links ─────────────────────

describe("the gate: autoLinkedCount tells the client a batch holds decided rows (D4)", () => {
  test("no unknowns, one team and one player auto-linked: the count is 2 and the batch holds both", async () => {
    // The dev incident: a fetch whose only review rows were auto-links came
    // back with both unknown lists empty, so the client committed it unseen.
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2010" });
    // Two closed eras the 2010 set year cannot separate: the in-sport lookup
    // answers null, and only set history can name the row.
    const browns1883 = await team(t, baseball, "St. Louis", "Browns");
    const browns1902 = await team(t, baseball, "St. Louis", "Browns");
    await t.run(async (ctx) => {
      await ctx.db.patch(browns1883, { yearsActive: { from: 1883, to: 1898 } });
      await ctx.db.patch(browns1902, { yearsActive: { from: 1902, to: 1953 } });
    });
    // A player of another sport the set already linked: history outranks the
    // in-sport lookup, which finds nobody.
    const bo = await player(t, football, "Bo Jackson");
    await committed(t, p.base, "1", {
      printed: [["Bo Jackson", bo]],
      teamIds: [browns1902],
    });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"], ["St. Louis Browns"]);

    expect(result.unknownPlayers).toEqual([]);
    expect(result.unknownTeams).toEqual([]);
    expect(result.batchId).toBeDefined();
    expect(result.autoLinkedCount).toBe(2);
    const rows = await rowsOf(t, result.batchId);
    expect(rows.map((r) => r.decision)).toEqual(
      expect.arrayContaining([
        { action: "link", linkedTeamId: browns1902, autoLinked: "setHistory" },
        { action: "link", linkedPlayerId: bo, autoLinked: "setHistory" },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  test("nothing auto-linked: the count is 0, with or without unknowns", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, baseball, "Bo Jackson");
    await committed(t, p.base, "1", { printed: [["Bo Jackson", bo]] });

    // History and the lookup agree (D3): silent, no batch.
    const silent = await gate(t, p.insert, baseball, ["Bo Jackson"]);
    expect(silent.batchId).toBeUndefined();
    expect(silent.autoLinkedCount).toBe(0);

    // An unknown name opens a batch, but nothing in it was decided for the operator.
    const unknown = await gate(t, p.insert, baseball, ["Nobody Anywhere"], ["Nowhere Nobodies"]);
    expect(unknown.batchId).toBeDefined();
    expect(unknown.unknownTeams).toEqual(["Nowhere Nobodies"]);
    expect(unknown.autoLinkedCount).toBe(0);
  });
});

// ─── Rule E: preselects ─────────────────────────────────────────────────────

describe("the gate: E1, the same product one year earlier", () => {
  /** Two football Bo Jacksons, so E2 can never be the one answering. */
  async function world(t: T) {
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const boA = await player(t, football, "Bo Jackson");
    const boB = await player(t, football, "Bo Jackson");
    return { baseball, football, boA, boB };
  }

  test("the prior year's link becomes the primary suggestion, never a decision", async () => {
    const t = newT();
    const { baseball, boA } = await world(t);
    const prior = await product(t, baseball, { year: "2023" });
    const now = await product(t, baseball, { year: "2024" });
    await committed(t, prior.base, "1", { printed: [["Bo Jackson", boA]] });

    const result = await gate(t, now.insert, baseball, ["Bo Jackson"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toBeUndefined();
    expect(row.status).toBe("ready");
    expect(row.enrichment?.preselect).toMatchObject({
      playerId: boA,
      sportValue: "Football",
      reason: "priorYearProduct",
    });
    expect(result.unknownPlayers).toEqual(["Bo Jackson"]);
  });

  test("two prior-year players under the name is no suggestion", async () => {
    const t = newT();
    const { baseball, boA, boB } = await world(t);
    const prior = await product(t, baseball, { year: "2023" });
    const now = await product(t, baseball, { year: "2024" });
    await committed(t, prior.base, "1", { printed: [["Bo Jackson", boA]] });
    await committed(t, prior.base, "2", { printed: [["Bo Jackson", boB]] });

    const result = await gate(t, now.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0].enrichment?.preselect).toBeUndefined();
  });

  test.each([
    ["a different brand", { year: "2023", brand: "Bowman" }],
    ["a different set", { year: "2023", set: "Series 2" }],
    ["two years back", { year: "2022" }],
    ["a LATER year", { year: "2025" }],
  ])("%s is not the same product", async (_label, opts) => {
    const t = newT();
    const { baseball, boA } = await world(t);
    const other = await product(t, baseball, opts);
    const now = await product(t, baseball, { year: "2024" });
    await committed(t, other.base, "1", { printed: [["Bo Jackson", boA]] });

    const result = await gate(t, now.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0].enrichment?.preselect).toBeUndefined();
  });

  test("the prior year in ANOTHER sport's tree is not the same product", async () => {
    const t = newT();
    const { baseball, football, boA } = await world(t);
    const priorElsewhere = await product(t, football, { year: "2023" });
    const now = await product(t, baseball, { year: "2024" });
    await committed(t, priorElsewhere.base, "1", { printed: [["Bo Jackson", boA]] });

    const result = await gate(t, now.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0].enrichment?.preselect).toBeUndefined();
  });

  test("two prior-year rows that are both 'Series 1' under Topps are not exactly one: no suggestion", async () => {
    const t = newT();
    const { baseball, boA } = await world(t);
    const prior = await product(t, baseball, { year: "2023" });
    const twin = await node(t, { level: "setName", value: "Series 1", parentId: prior.brand });
    const twinBase = await node(t, { level: "variantType", value: "Base", parentId: twin });
    await committed(t, prior.base, "1", { printed: [["Bo Jackson", boA]] });
    await committed(t, twinBase, "1", { printed: [["Bo Jackson", boA]] });
    const now = await product(t, baseball, { year: "2024" });

    const result = await gate(t, now.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0].enrichment?.preselect).toBeUndefined();
  });

  test("E1 outranks E2: the prior year's player beats the one namesake in NB", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const lone = await player(t, football, "Bo Jackson");
    const vincent = await player(t, baseball, "Vincent Edward Jackson");
    const prior = await product(t, baseball, { year: "2023" });
    const now = await product(t, baseball, { year: "2024" });
    await committed(t, prior.base, "1", { printed: [["Bo Jackson", vincent]] });

    const result = await gate(t, now.insert, baseball, ["Bo Jackson"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.enrichment?.preselect).toMatchObject({
      playerId: vincent,
      reason: "priorYearProduct",
    });
    expect(row.enrichment?.preselect?.playerId).not.toBe(lone);
  });
});

describe("the gate: E2, the only namesake in any sport", () => {
  test("a name nobody in the set's sport answers to, with exactly one namesake elsewhere", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, football, "Bo Jackson");

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.decision).toBeUndefined();
    expect(row.status).toBe("ready");
    expect(row.sportId).toBe(baseball);
    expect(row.enrichment?.preselect).toMatchObject({
      playerId: bo,
      sportId: football,
      sportValue: "Football",
      reason: "onlyNamesake",
    });
  });

  test("two namesakes in other sports is no suggestion, and the row is looked up as ever", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const hockey = await sport(t, "Hockey");
    const p = await product(t, baseball, { year: "2024" });
    await player(t, football, "Bo Jackson");
    await player(t, hockey, "Bo Jackson");

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.enrichment?.preselect).toBeUndefined();
    expect(row.status).toBe("pending");
  });

  test("an ALIAS counts as answering to the name", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const vincent = await player(t, football, "Vincent Edward Jackson");
    await t.run((ctx) =>
      ctx.db.insert("playerAliases", {
        playerId: vincent,
        sportId: football,
        aliasNormalized: normalizePlayerName("Bo Jackson"),
      }),
    );

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0].enrichment?.preselect).toMatchObject({
      playerId: vincent,
      reason: "onlyNamesake",
    });
  });

  test("a primary name plus an alias row for the SAME player is still one namesake", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, football, "Bo Jackson");
    await t.run(async (ctx) => {
      await ctx.db.insert("playerAliases", {
        playerId: bo,
        sportId: football,
        aliasNormalized: normalizePlayerName("Bo Jackson"),
      });
    });

    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);

    expect((await rowsOf(t, result.batchId))[0].enrichment?.preselect).toMatchObject({
      playerId: bo,
    });
  });

  test("a name two in-sport players share (a pick step) gets no namesake suggestion", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    await player(t, baseball, "Bob Allen", { birthYear: 1867 });
    await player(t, baseball, "Bob Allen", { birthYear: 1937 });

    const result = await gate(t, p.insert, baseball, ["Bob Allen"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.enrichment?.existingCandidates).toHaveLength(2);
    expect(row.enrichment?.preselect).toBeUndefined();
  });

  test("a name with no namesake anywhere is an ordinary pending row", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });

    const result = await gate(t, p.insert, baseball, ["Travis Bazzana"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.status).toBe("pending");
    expect(row.enrichment?.preselect).toBeUndefined();
  });
});

describe("the gate: rule E at volume and with stale ids", () => {
  test("namesake lookups are sliced: a name past the per-call bound still gets its suggestion", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const names = Array.from({ length: NAMESAKE_NAMES_PER_CALL + 10 }, (_, i) => `Rookie Number${i}`);
    const last = names[names.length - 1];
    const lone = await player(t, football, last);

    const result = await t.withIdentity(ADMIN_IDENTITY).action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: p.insert,
        sportId: baseball,
        cards: names.map((n, i) => fetchedCard([n], [], `I-${i}`)),
      },
    );

    const row = (await rowsOf(t, result.batchId)).find((r) => r.name === last)!;
    expect(row.enrichment?.preselect).toMatchObject({ playerId: lone, reason: "onlyNamesake" });
  });

  test("a prior-year player deleted since is no suggestion, and the row is looked up as ever", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const gone = await player(t, football, "Bo Jackson");
    const prior = await product(t, baseball, { year: "2023" });
    const now = await product(t, baseball, { year: "2024" });
    await committed(t, prior.base, "1", { printed: [["Bo Jackson", gone]] });
    await t.run((ctx) => ctx.db.delete(gone));

    const result = await gate(t, now.insert, baseball, ["Bo Jackson"]);

    const [row] = await rowsOf(t, result.batchId);
    expect(row.enrichment?.preselect).toBeUndefined();
    expect(row.status).toBe("pending");
  });
});

// ─── The scan: caps, incomplete history, slicing ────────────────────────────

describe("scanSetHistory: an incomplete history is not used at all", () => {
  test("a node cap hit by the subtree walk gives an empty, incomplete history", async () => {
    const fake = {
      runQuery: vi.fn(async (ref: unknown) => {
        if (getFunctionName(ref as never).includes("historyNodes")) return { nodeIds: [], truncated: true };
        throw new Error("nothing else may be read after a truncated walk");
      }),
    } as unknown as ActionCtx;

    const history = await scanSetHistory(fake, {
      selectorOptionId: "x" as Id<"selectorOptions">,
    });

    expect(history.complete).toBe(false);
    expect(history.playersByName.size).toBe(0);
    expect(history.teamIds.size).toBe(0);
  });

  test("a card-read call cap leaves what was read UNUSED, not half-used", async () => {
    let calls = 0;
    const fake = {
      runQuery: vi.fn(async (ref: unknown) => {
        if (getFunctionName(ref as never).includes("historyNodes")) {
          return { nodeIds: ["n1" as Id<"selectorOptions">], truncated: false };
        }
        calls++;
        // A node that never finishes: always a cursor, never nodesDone.
        return {
          links: [{ nameNormalized: "jackson bo", playerId: "p1" as Id<"players"> }],
          legacyPlayerIds: [],
          teamIds: ["t1" as Id<"teams">],
          nodesDone: 0,
          cursor: "more",
        };
      }),
    } as unknown as ActionCtx;

    const history = await scanSetHistory(fake, {
      selectorOptionId: "x" as Id<"selectorOptions">,
    });

    expect(calls).toBe(SET_HISTORY_MAX_CALLS);
    expect(history.complete).toBe(false);
    expect(history.playersByName.size).toBe(0);
    expect(history.teamIds.size).toBe(0);
  });

  test("a real subtree over the node cap: the gate falls back to today's path", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const football = await sport(t, "Football");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, football, "Bo Jackson");
    const boBaseball = await player(t, baseball, "Bo Jackson");
    await committed(t, p.base, "1", { printed: [["Bo Jackson", bo]] });
    await t.run(async (ctx) => {
      for (let i = 0; i < SET_HISTORY_MAX_NODES + 5; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Filler ${i}`,
          parentId: p.set,
          platformData: {},
          children: [],
          lastUpdated: Date.now(),
        });
      }
    });

    const history = await scanSetHistory(actionCtxFor(t), {
      selectorOptionId: p.insert,
    });
    expect(history.complete).toBe(false);

    // History would have auto-linked the football Bo Jackson; the incomplete
    // scan is ignored, so the lone baseball Bo Jackson answers, silently.
    const result = await gate(t, p.insert, baseball, ["Bo Jackson"]);
    expect(result.unknownPlayers).toEqual([]);
    expect(result.batchId).toBeUndefined();
    void boBaseball;
  });
});

describe("historyNodes and historyCardBatch: slicing", () => {
  test("parallel-level nodes come LAST", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const gold = await node(t, { level: "parallel", value: "Gold", parentId: p.insert });
    // Created after the parallel on purpose: order must come from the level.
    const promo = await node(t, { level: "variantType", value: "Promo", parentId: p.set });

    const all = await t.query(internal.setHistory.historyNodes, {
      selectorOptionId: p.base,
    });
    expect(all.truncated).toBe(false);
    expect(all.nodeIds[all.nodeIds.length - 1]).toBe(gold);
    expect(all.nodeIds.indexOf(promo)).toBeLessThan(all.nodeIds.indexOf(gold));
    expect(all.nodeIds).toContain(p.base);
  });

  test("a set with no setName ancestor is an empty, COMPLETE history", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const orphan = await node(t, { level: "variantType", value: "Base", parentId: baseball });

    const result = await t.query(internal.setHistory.historyNodes, {
      selectorOptionId: orphan,
    });

    expect(result).toEqual({ nodeIds: [], truncated: false });
  });

  test("a node over 500 cards is paged: the first call stops inside it, the next resumes and loses nothing", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const total = SET_HISTORY_CARDS_PER_CALL + 25;
    const ids: Array<Id<"players">> = [];
    for (let i = 0; i < total; i++) ids.push(await player(t, baseball, `Player Number${i}`));
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        await insertTestCard(ctx, {
          selectorOptionId: p.base,
          cardNumber: String(i + 1),
          cardName: "Card",
          platformData: {},
          sortOrder: i,
          lastUpdated: Date.now(),
          playerIds: [ids[i]],
          playerLinks: [{ playerId: ids[i], nameOnCard: `Player Number${i}` }],
        });
      }
    });

    const first = await t.query(internal.setHistory.historyCardBatch, {
      nodeIds: [p.base],
      cursor: null,
    });
    expect(first.nodesDone).toBe(0);
    expect(first.cursor).not.toBeNull();
    expect(first.links).toHaveLength(SET_HISTORY_CARDS_PER_CALL);

    const second = await t.query(internal.setHistory.historyCardBatch, {
      nodeIds: [p.base],
      cursor: first.cursor,
    });
    expect(second.nodesDone).toBe(1);
    expect(second.cursor).toBeNull();
    expect(second.links).toHaveLength(total - SET_HISTORY_CARDS_PER_CALL);

    // And the whole scan sees every one of them, exactly once.
    const history = await scanSetHistory(actionCtxFor(t), {
      selectorOptionId: p.insert,
    });
    expect(history.complete).toBe(true);
    expect(history.playersByName.size).toBe(total);
    // The set's own (empty) node, then the big node in two pages.
    expect(history.stats.calls).toBe(3);
  });

  test("many small nodes share ONE call", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const bo = await player(t, baseball, "Bo Jackson");
    const nodes: Sel[] = [];
    for (let i = 0; i < 40; i++) {
      const n = await node(t, { level: "parallel", value: `Parallel ${i}`, parentId: p.insert });
      await committed(t, n, "1", { printed: [["Bo Jackson", bo]] });
      nodes.push(n);
    }

    const batch = await t.query(internal.setHistory.historyCardBatch, {
      nodeIds: nodes,
      cursor: null,
    });

    expect(batch.nodesDone).toBe(40);
    expect(batch.cursor).toBeNull();
    // Deduped across nodes: one (name, player) pair, not forty.
    expect(batch.links).toHaveLength(1);

    const history = await scanSetHistory(actionCtxFor(t), {
      selectorOptionId: p.base,
    });
    expect(history.complete).toBe(true);
    expect(history.stats.calls).toBe(1);
  });

  test("a node that does not fit beside the one before it is left whole for the next call", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });
    const big = await node(t, { level: "variantType", value: "Big", parentId: p.set });
    const next = await node(t, { level: "variantType", value: "Next", parentId: p.set });
    const bo = await player(t, baseball, "Bo Jackson");
    await t.run(async (ctx) => {
      for (let i = 0; i < 400; i++) {
        await insertTestCard(ctx, {
          selectorOptionId: big,
          cardNumber: String(i),
          cardName: "Card",
          platformData: {},
          sortOrder: i,
          lastUpdated: Date.now(),
        });
      }
      for (let i = 0; i < 200; i++) {
        await insertTestCard(ctx, {
          selectorOptionId: next,
          cardNumber: String(i),
          cardName: "Card",
          platformData: {},
          sortOrder: i,
          lastUpdated: Date.now(),
          playerIds: [bo],
          playerLinks: [{ playerId: bo, nameOnCard: "Bo Jackson" }],
        });
      }
    });

    const first = await t.query(internal.setHistory.historyCardBatch, {
      nodeIds: [big, next],
      cursor: null,
    });
    // `next` would push the call past 500 cards, so NOTHING of it is read:
    // half a node would let one of two players hide behind the cut.
    expect(first.nodesDone).toBe(1);
    expect(first.links).toHaveLength(0);

    const second = await t.query(internal.setHistory.historyCardBatch, {
      nodeIds: [next],
      cursor: null,
    });
    expect(second.nodesDone).toBe(1);
    expect(second.links).toHaveLength(1);
  });

  test("a call handed more nodes than its bound is refused, not served short", async () => {
    const t = newT();
    const baseball = await sport(t, "Baseball");
    const p = await product(t, baseball, { year: "2024" });

    await expect(
      t.query(internal.setHistory.historyCardBatch, {
        nodeIds: Array.from({ length: SET_HISTORY_NODES_PER_CALL + 1 }, () => p.base),
        cursor: null,
      }),
    ).rejects.toThrow(/exceeds/);
  });

  test("no nodes is an empty batch", async () => {
    const t = newT();
    const batch = await t.query(internal.setHistory.historyCardBatch, {
      nodeIds: [],
      cursor: null,
    });
    expect(batch).toEqual({
      links: [],
      legacyPlayerIds: [],
      teamIds: [],
      nodesDone: 0,
      cursor: null,
    });
  });
});
