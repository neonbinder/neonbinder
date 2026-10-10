/**
 * NEO-333 — a comma-separated BSC team value is several teams, unless the
 * WHOLE string names exactly one existing team or alias.
 *
 * Two resolvers decide that, and they must agree:
 *
 *  - `cardChecklist.applyBscTeamResolution` (the background queue): links a
 *    card only when the whole string resolves, or EVERY split part does;
 *    otherwise it links nothing and keeps BSC's raw string as the hint.
 *  - `checklistCandidates.resolveCandidateTeams` (the pairing dialog's fetch):
 *    picks which string(s) the candidate card carries — the raw string when it
 *    resolves, else the split parts (unknown parts go to review).
 *
 * Fixtures are raw `t.run` inserts, like `teamAliasLookups.test.ts`: a
 * sport → year → setName → variantType chain (the year row is what gives the
 * set a year), teams with and without aliases.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

let harnesses: T[] = [];
function harness(): T {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  return t;
}

beforeEach(() => {
  harnesses = [];
  // No test here may reach the network; a stray scheduled BSC call would.
  vi.stubGlobal("fetch", (async (url: string | URL) => {
    throw new Error(`NEO-333: test must not reach the network: ${String(url)}`);
  }) as unknown as typeof fetch);
});

afterEach(async () => {
  for (const t of harnesses) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id);
        }
      }
    });
  }
  harnesses = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedSet(
  t: T,
  opts: { sport?: string; year?: string } = {},
): Promise<{ sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: opts.sport ?? "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: opts.year ?? "2024",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: 1,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: 1,
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: 1,
    });
    return { sportId, leafId };
  });
}

/** A second sport row, for a team that exists under a DIFFERENT sport. */
async function seedOtherSport(t: T): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      platformData: {},
      children: [],
      lastUpdated: 1,
    }),
  );
}

/** A team plus its alias index rows, as `syncTeamAliases` leaves them. */
async function seedTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  opts: {
    name: string;
    location?: string;
    aliases?: string[];
    yearsActive?: { from: number; to?: number };
  },
): Promise<Id<"teams">> {
  return t.run(async (ctx) => {
    const full = opts.location ? `${opts.location} ${opts.name}` : opts.name;
    const id = await ctx.db.insert("teams", {
      name: opts.name,
      ...(opts.location ? { location: opts.location } : {}),
      nameNormalized: normalizeTeamName(full),
      sportId,
      ...(opts.aliases?.length ? { aliases: opts.aliases } : {}),
      ...(opts.yearsActive ? { yearsActive: opts.yearsActive } : {}),
      lastUpdated: 1,
    });
    for (const alias of opts.aliases ?? []) {
      await ctx.db.insert("teamAliases", {
        teamId: id,
        sportId,
        aliasNormalized: normalizeTeamName(alias),
      });
    }
    return id;
  });
}

async function seedCard(
  t: T,
  leafId: Id<"selectorOptions">,
  extra: { teamNoneConfirmedAt?: number } = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId: leafId,
      cardNumber: "1",
      cardName: "Card 1",
      platformData: { bsc: { ref: "bsc-1", src: "b0" } },
      sortOrder: 1,
      lastUpdated: 1,
      ...extra,
    }),
  );
}

const getCard = (t: T, id: Id<"cardChecklist">) => t.run(async (ctx) => ctx.db.get(id));

function apply(
  t: T,
  cardChecklistId: Id<"cardChecklist">,
  rawTeamName: string,
  teamNames: string[],
) {
  return t.mutation(internal.cardChecklist.applyBscTeamResolution, {
    cardChecklistId,
    rawTeamName,
    teamNames,
  });
}

const CLE = "Cleveland Guardians";
const WSH = "Washington Nationals";
const RAIL = "Scranton, Wilkes-Barre RailRiders";

// ===========================================================================
// applyBscTeamResolution
// ===========================================================================

describe("applyBscTeamResolution: whole string first (NEO-333)", () => {
  test("the raw string resolves BY NAME to one team, and the split is never consulted", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    // "Korea, South" is ONE team whose own name carries a comma. Teams named
    // "Korea" and "South" also exist: the split would link those, wrongly.
    const korea = await seedTeam(t, sportId, { name: "Korea, South" });
    await seedTeam(t, sportId, { name: "Korea" });
    await seedTeam(t, sportId, { name: "South" });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, "Korea, South", ["Korea", "South"]);

    expect(result).toEqual({ applied: true, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toEqual([korea]);
    expect(card!.bscTeamName).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("the raw string resolves BY ALIAS to one team", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const railRiders = await seedTeam(t, sportId, {
      location: "Scranton/Wilkes-Barre",
      name: "RailRiders",
      aliases: [RAIL],
    });
    const cardId = await seedCard(t, leafId);

    // The parts "Scranton" and "Wilkes-Barre RailRiders" hold no team.
    const result = await apply(t, cardId, RAIL, ["Scranton", "Wilkes-Barre RailRiders"]);

    expect(result).toEqual({ applied: true, unmatched: false });
    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([railRiders]);
  });

  test("the alias is matched after normalisation: case and punctuation do not matter", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const railRiders = await seedTeam(t, sportId, {
      location: "Scranton/Wilkes-Barre",
      name: "RailRiders",
      aliases: [RAIL],
    });
    const cardId = await seedCard(t, leafId);

    await apply(t, cardId, "SCRANTON,   wilkes-barre railriders", [
      "SCRANTON",
      "wilkes-barre railriders",
    ]);

    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([railRiders]);
  });

  test("a whole string that names TWO teams (ambiguous) is still ONE team: unmatched with the raw hint, the split never tried", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    // Two undated rows answer to the whole string: not "exactly one", so the
    // whole-name step cannot LINK the card — but the string is a known team,
    // so cutting it at its comma would be wrong even though both parts are
    // teams NB holds.
    await seedTeam(t, sportId, { name: "Korea, South" });
    await seedTeam(t, sportId, { name: "Korea, South", location: "X" , aliases: ["Korea, South"] });
    await seedTeam(t, sportId, { name: "Korea" });
    await seedTeam(t, sportId, { name: "South" });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, "Korea, South", ["Korea", "South"]);

    expect(result).toEqual({ applied: false, unmatched: true });
    const card = (await getCard(t, cardId))!;
    expect(card.teamOnCardIds ?? []).toEqual([]);
    expect(card.bscTeamName).toBe("Korea, South");
    expect(card.teamCheckDoneAt).toBeDefined();
  });
});

describe("applyBscTeamResolution: the split (NEO-333)", () => {
  test("the whole string fails and both parts resolve: both ids, in BSC's order", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const cle = await seedTeam(t, sportId, { name: CLE });
    const wsh = await seedTeam(t, sportId, { name: WSH });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, `${WSH}, ${CLE}`, [WSH, CLE]);

    expect(result).toEqual({ applied: true, unmatched: false });
    const card = await getCard(t, cardId);
    // Order is BSC's (Washington first), not insertion or alphabetical.
    expect(card!.teamOnCardIds).toEqual([wsh, cle]);
    expect(card!.bscTeamName).toBeUndefined();
  });

  test("the whole string fails and ONE part fails: no ids, the hint is the raw string", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { name: CLE });
    const cardId = await seedCard(t, leafId);
    const raw = `${CLE}, ${WSH}`;

    const result = await apply(t, cardId, raw, [CLE, WSH]);

    expect(result).toEqual({ applied: false, unmatched: true });
    const card = await getCard(t, cardId);
    // Nothing partial: the resolved half is NOT linked (Jason, 2026-10-10).
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    expect(card!.bscTeamName).toBe(raw);
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
    expect(card!.pendingTeamNames ?? []).toEqual([]);
  });

  test("when the FIRST part fails, the later (known) part is not linked either", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { name: WSH });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, `${CLE}, ${WSH}`, [CLE, WSH]);

    expect(result).toEqual({ applied: false, unmatched: true });
    expect((await getCard(t, cardId))!.teamOnCardIds ?? []).toEqual([]);
  });

  test("a team listed twice (by name and by alias) links once", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const cle = await seedTeam(t, sportId, {
      name: CLE,
      aliases: ["Cleveland Indians"],
    });
    const cardId = await seedCard(t, leafId);

    await apply(t, cardId, `${CLE}, Cleveland Indians`, [CLE, "Cleveland Indians"]);

    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([cle]);
  });

  test("padded parts are trimmed before the lookup", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const cle = await seedTeam(t, sportId, { name: CLE });
    const wsh = await seedTeam(t, sportId, { name: WSH });
    const cardId = await seedCard(t, leafId);

    await apply(t, cardId, `  ${CLE},${WSH}  `, [`  ${CLE} `, ` ${WSH}`, "   "]);

    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([cle, wsh]);
  });

  test("an empty split with a raw string is UNMATCHED with the raw hint, not 'no team on file'", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    // What the adapter hands on when BSC named more teams than a card carries.
    const raw = Array.from({ length: 9 }, (_, i) => `Team ${i}`).join(", ");

    const result = await apply(t, cardId, raw, []);

    expect(result).toEqual({ applied: false, unmatched: true });
    const card = await getCard(t, cardId);
    expect(card!.bscTeamName).toBe(raw);
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("an empty split whose raw string IS one existing team still links it", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const korea = await seedTeam(t, sportId, { name: "Korea, South" });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, "Korea, South", []);

    expect(result).toEqual({ applied: true, unmatched: false });
    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([korea]);
  });

  test("more than 8 parts links nothing even when every part is a known team", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const names = Array.from({ length: 9 }, (_, i) => `Team ${i}`);
    for (const name of names) await seedTeam(t, sportId, { name });
    const cardId = await seedCard(t, leafId);
    const raw = names.join(", ");

    const result = await apply(t, cardId, raw, names);

    expect(result).toEqual({ applied: false, unmatched: true });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    expect(card!.bscTeamName).toBe(raw);
  });

  test("exactly 8 known parts all link", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const names = Array.from({ length: 8 }, (_, i) => `Team ${i}`);
    const ids: Id<"teams">[] = [];
    for (const name of names) ids.push(await seedTeam(t, sportId, { name }));
    const cardId = await seedCard(t, leafId);

    await apply(t, cardId, names.join(", "), names);

    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual(ids);
  });

  test("the hint is capped at 120 characters and an over-long raw string is never whole-matched", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    const raw = `${"Y".repeat(80)}, ${"Z".repeat(80)}`;

    await apply(t, cardId, raw, ["Y".repeat(80), "Z".repeat(80)]);

    expect((await getCard(t, cardId))!.bscTeamName).toBe(raw.slice(0, 120));
  });

  test("a raw string with no parts at all falls back to the joined parts for the hint", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, "", [CLE, WSH]);

    expect(result).toEqual({ applied: false, unmatched: true });
    expect((await getCard(t, cardId))!.bscTeamName).toBe(`${CLE}, ${WSH}`);
  });
});

describe("applyBscTeamResolution: an over-cap split (security review N2)", () => {
  test("more than MAX_CARD_TEAMS parts with NO raw string: unmatched, stamped, and no hint kept", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const names = Array.from({ length: 9 }, (_, i) => `Team ${i}`);
    for (const name of names) await seedTeam(t, sportId, { name });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, "", names);

    // Not "no team on file": BSC did name teams, so the card stays reviewable.
    expect(result).toEqual({ applied: false, unmatched: true });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    expect(card!.bscTeamName).toBeUndefined();
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });

  test("more than MAX_CARD_TEAMS parts, but the raw string IS one team: the raw match still links", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const korea = await seedTeam(t, sportId, { name: "Korea, South" });
    const cardId = await seedCard(t, leafId);
    const parts = Array.from({ length: 9 }, (_, i) => `Part ${i}`);

    const result = await apply(t, cardId, "Korea, South", parts);

    expect(result).toEqual({ applied: true, unmatched: false });
    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([korea]);
  });

  test("an over-cap array of blanks and repeats is judged by its length as received", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);

    // 9 entries, which would dedupe to 1, but the bound is on what arrived.
    const result = await apply(t, cardId, "", Array.from({ length: 9 }, () => CLE));

    expect(result).toEqual({ applied: false, unmatched: true });
  });
});

describe("applyBscTeamResolution: scope (NEO-333)", () => {
  test("a team that exists only in ANOTHER sport does not resolve the raw string or a part", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const hockey = await seedOtherSport(t);
    await seedTeam(t, hockey, { name: "Korea, South" });
    await seedTeam(t, hockey, { name: CLE });
    const cardId = await seedCard(t, leafId);

    const whole = await apply(t, cardId, "Korea, South", ["Korea", "South"]);
    expect(whole).toEqual({ applied: false, unmatched: true });

    await t.run(async (ctx) => ctx.db.patch(cardId, { teamCheckDoneAt: undefined }));
    const split = await apply(t, cardId, `${CLE}, ${WSH}`, [CLE, WSH]);
    expect(split).toEqual({ applied: false, unmatched: true });
    expect((await getCard(t, cardId))!.teamOnCardIds ?? []).toEqual([]);
  });

  test("a raw string whose only team is a FUTURE era (set year 2024) does not link", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t, { year: "2024" });
    await seedTeam(t, sportId, { name: "Korea, South", yearsActive: { from: 2030 } });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, "Korea, South", ["Korea", "South"]);

    expect(result).toEqual({ applied: false, unmatched: true });
  });

  test("a raw string whose only team is a PAST era still links (a card can show a team's past)", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t, { year: "2015" });
    const old = await seedTeam(t, sportId, {
      name: "Korea, South",
      yearsActive: { from: 1972, to: 1996 },
    });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, "Korea, South", ["Korea", "South"]);

    expect(result).toEqual({ applied: true, unmatched: false });
    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([old]);
  });

  test("a part with two same-name eras the year cannot separate counts as UNRESOLVED", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t, { year: "1990" });
    await seedTeam(t, sportId, { name: CLE });
    // Two undated rows of the same name: the year cannot pick one.
    await seedTeam(t, sportId, { name: WSH, yearsActive: { from: 1980, to: 2000 } });
    await seedTeam(t, sportId, { name: WSH, yearsActive: { from: 1985, to: 2005 } });
    const cardId = await seedCard(t, leafId);

    const result = await apply(t, cardId, `${CLE}, ${WSH}`, [CLE, WSH]);

    expect(result).toEqual({ applied: false, unmatched: true });
    expect((await getCard(t, cardId))!.teamOnCardIds ?? []).toEqual([]);
  });
});

describe("applyBscTeamResolution: operator-owned state (NEO-333)", () => {
  test("a none-confirmed card is left completely alone by a multi-team value", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { name: CLE });
    await seedTeam(t, sportId, { name: WSH });
    const cardId = await seedCard(t, leafId, { teamNoneConfirmedAt: 123 });

    const result = await apply(t, cardId, `${CLE}, ${WSH}`, [CLE, WSH]);

    expect(result).toEqual({ applied: false, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toBeUndefined();
    expect(card!.bscTeamName).toBeUndefined();
    expect(card!.teamNoneConfirmedAt).toBe(123);
  });

  test("a card that already has teams is not overwritten by a different multi-team value", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const original = await seedTeam(t, sportId, { name: "Original" });
    await seedTeam(t, sportId, { name: CLE });
    await seedTeam(t, sportId, { name: WSH });
    const cardId = await seedCard(t, leafId);
    await t.run(async (ctx) => ctx.db.patch(cardId, { teamOnCardIds: [original] }));

    const result = await apply(t, cardId, `${CLE}, ${WSH}`, [CLE, WSH]);

    expect(result.applied).toBe(false);
    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([original]);
  });

  test("a later complete match clears the hint an earlier partial miss left", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { name: CLE });
    const cardId = await seedCard(t, leafId);
    const raw = `${CLE}, ${WSH}`;

    await apply(t, cardId, raw, [CLE, WSH]);
    expect((await getCard(t, cardId))!.bscTeamName).toBe(raw);

    // The operator adds the missing team; a re-run links both.
    await seedTeam(t, sportId, { name: WSH });
    await t.run(async (ctx) => ctx.db.patch(cardId, { teamCheckDoneAt: undefined }));
    await apply(t, cardId, raw, [CLE, WSH]);

    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toHaveLength(2);
    expect(card!.bscTeamName).toBeUndefined();
  });
});

// ===========================================================================
// resolveCandidateTeams / chooseCandidateTeams
// ===========================================================================

describe("resolveCandidateTeams: which team strings a candidate card carries (NEO-333)", () => {
  async function seedBatch(t: T, leafId: Id<"selectorOptions">) {
    await t.mutation(internal.checklistCandidates.startCandidateBatch, {
      selectorOptionId: leafId,
      batchId: "batch-1",
      userId: "admin_333",
      candidates: [
        {
          cardNumber: "1",
          cardName: "Card 1",
          platformData: { bsc: { ref: "b1" } },
          bucket: "matched" as const,
        },
      ],
      readyImmediately: false,
    });
  }

  async function resolve(
    t: T,
    entry: { rawTeamName?: string; teamNames?: string[] },
  ): Promise<{ teams: string[] | undefined; status: string }> {
    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      resolved: [{ bscRef: "b1", ...entry }],
    });
    return t.run(async (ctx) => {
      const rows = await ctx.db.query("checklistCandidates").collect();
      return { teams: rows[0].teams, status: rows[0].status };
    });
  }

  test("the raw string names an existing team: the card carries that ONE string", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { name: "Korea, South" });
    await seedBatch(t, leafId);

    const out = await resolve(t, { rawTeamName: "Korea, South", teamNames: ["Korea", "South"] });

    expect(out).toEqual({ teams: ["Korea, South"], status: "ready" });
  });

  test("the raw string is an ALIAS of one team: the card carries the raw string", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, {
      location: "Scranton/Wilkes-Barre",
      name: "RailRiders",
      aliases: [RAIL],
    });
    await seedBatch(t, leafId);

    const out = await resolve(t, { rawTeamName: RAIL, teamNames: ["Scranton", "Wilkes-Barre RailRiders"] });

    expect(out.teams).toEqual([RAIL]);
  });

  test("the raw string resolves to nothing: the card carries the split parts, known or not", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { name: CLE });
    await seedBatch(t, leafId);

    // WSH is unknown: it still rides along so the review wizard can ask.
    const out = await resolve(t, { rawTeamName: `${CLE}, ${WSH}`, teamNames: [CLE, WSH] });

    expect(out).toEqual({ teams: [CLE, WSH], status: "ready" });
  });

  test("a raw string with no comma and one part is just that part", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    await seedBatch(t, leafId);

    const out = await resolve(t, { rawTeamName: "Phillies", teamNames: ["Phillies"] });

    expect(out.teams).toEqual(["Phillies"]);
  });

  test("an empty split whose raw string resolves still carries the raw string", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { name: "Korea, South" });
    await seedBatch(t, leafId);

    const out = await resolve(t, { rawTeamName: "Korea, South", teamNames: [] });

    expect(out.teams).toEqual(["Korea, South"]);
  });

  test("an empty split whose raw string does NOT resolve carries no teams but releases the card", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    await seedBatch(t, leafId);
    const raw = Array.from({ length: 9 }, (_, i) => `Team ${i}`).join(", ");

    const out = await resolve(t, { rawTeamName: raw, teamNames: [] });

    expect(out).toEqual({ teams: undefined, status: "ready" });
  });

  test("more than 8 parts are refused, never trimmed", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const names = Array.from({ length: 9 }, (_, i) => `Team ${i}`);
    for (const name of names) await seedTeam(t, sportId, { name });
    await seedBatch(t, leafId);

    const out = await resolve(t, { rawTeamName: names.join(", "), teamNames: names });

    expect(out.teams).toBeUndefined();
    expect(out.status).toBe("ready");
  });

  test("an over-length part is refused with the whole list", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    await seedBatch(t, leafId);
    const long = "Y".repeat(121);

    const out = await resolve(t, { rawTeamName: `${CLE}, ${long}`, teamNames: [CLE, long] });

    expect(out.teams).toBeUndefined();
  });

  /**
   * When the whole string is a KNOWN team that two same-name rows share and
   * the set's year cannot separate (`resolveTeamForSetYear` -> null), the card
   * keeps the raw string, so the gate's own ambiguity question (which era?) is
   * the one asked — never "Scranton" + "Wilkes-Barre RailRiders" as two new
   * teams. (Found by the adversarial pass; fixed in `chooseCandidateTeams`.)
   */
  test("a known team with two undecidable eras keeps the RAW string instead of being cut at its comma", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t, { year: "1990" });
    await seedTeam(t, sportId, { name: RAIL, yearsActive: { from: 1980, to: 2000 } });
    await seedTeam(t, sportId, { name: RAIL, yearsActive: { from: 1985, to: 2005 } });
    await seedBatch(t, leafId);

    const out = await resolve(t, {
      rawTeamName: RAIL,
      teamNames: ["Scranton", "Wilkes-Barre RailRiders"],
    });

    expect(out.teams).toEqual([RAIL]);
  });

  test("a raw string over 120 characters is never whole-matched, even when a team has that exact name", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const longName = `${"Y".repeat(70)}, ${"Z".repeat(60)}`;
    await seedTeam(t, sportId, { name: longName });
    await seedBatch(t, leafId);

    const out = await resolve(t, {
      rawTeamName: longName,
      teamNames: ["Y".repeat(70), "Z".repeat(60)],
    });

    expect(longName.length).toBeGreaterThan(120);
    expect(out.teams).toEqual(["Y".repeat(70), "Z".repeat(60)]);
  });

  test("over-cap parts are refused even when every part is a known team", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const names = Array.from({ length: 9 }, (_, i) => `Team ${i}`);
    for (const name of names) await seedTeam(t, sportId, { name });
    await seedBatch(t, leafId);

    const out = await resolve(t, { rawTeamName: "", teamNames: names });

    expect(out).toEqual({ teams: undefined, status: "ready" });
  });

  test("a team that exists only in another sport does not turn the raw string into one team", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const hockey = await seedOtherSport(t);
    await seedTeam(t, hockey, { name: "Korea, South" });
    await seedBatch(t, leafId);

    const out = await resolve(t, { rawTeamName: "Korea, South", teamNames: ["Korea", "South"] });

    expect(out.teams).toEqual(["Korea", "South"]);
  });

  test("a set with no sport ancestor falls back to the split parts rather than throwing", async () => {
    const t = harness();
    const orphan = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Insert",
        platformData: {},
        lastUpdated: 1,
      }),
    );
    await seedBatch(t, orphan);

    const out = await resolve(t, { rawTeamName: `${CLE}, ${WSH}`, teamNames: [CLE, WSH] });

    expect(out.teams).toEqual([CLE, WSH]);
  });

  test("a future-era-only team still makes the raw string ONE team (the gate, not the split, decides)", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t, { year: "2024" });
    await seedTeam(t, sportId, { name: "Korea, South", yearsActive: { from: 2030 } });
    await seedBatch(t, leafId);

    const out = await resolve(t, { rawTeamName: "Korea, South", teamNames: ["Korea", "South"] });

    // ANY row answering to the whole string means it names one team, even
    // one this set's year cannot link; cutting it at its comma would send two
    // made-up teams to review.
    expect(out.teams).toEqual(["Korea, South"]);
  });

  test("a legacy entry with only a name-less shape (no raw, no parts) carries no teams", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    await seedBatch(t, leafId);

    const out = await resolve(t, {});

    expect(out).toEqual({ teams: undefined, status: "ready" });
  });
});

describe("resolveCandidateTeams: the retry keeps the raw string (NEO-333)", () => {
  test("a missed ref is rescheduled carrying rawTeamName AND teamNames, unchanged", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { leafId } = await seedSet(t);

    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      resolved: [{ bscRef: "late", rawTeamName: "Korea, South", teamNames: ["Korea", "South"] }],
    });

    const jobs = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (j) => j.name === "checklistCandidates:resolveCandidateTeams",
      ),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toEqual({
      batchId: "batch-1",
      resolved: [{ bscRef: "late", rawTeamName: "Korea, South", teamNames: ["Korea", "South"] }],
      retry: true,
    });
    void leafId;
  });

  test("the retry, once its row exists, decides by the raw string exactly as the first pass would", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { name: "Korea, South" });

    // First pass: no row yet.
    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      resolved: [{ bscRef: "b1", rawTeamName: "Korea, South", teamNames: ["Korea", "South"] }],
    });
    // The row arrives, then the retry fires.
    await t.mutation(internal.checklistCandidates.startCandidateBatch, {
      selectorOptionId: leafId,
      batchId: "batch-1",
      userId: "admin_333",
      candidates: [
        {
          cardNumber: "1",
          cardName: "Card 1",
          platformData: { bsc: { ref: "b1" } },
          bucket: "matched" as const,
        },
      ],
      readyImmediately: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run(async (ctx) => ctx.db.query("checklistCandidates").collect());
    expect(rows[0].teams).toEqual(["Korea, South"]);
    expect(rows[0].status).toBe("ready");
  });
});
