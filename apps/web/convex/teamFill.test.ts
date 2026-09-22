/**
 * NEO-279 — the "Fill teams" wiring: `previewTeamFill` / `applyTeamFill`
 * (admin actions), the internal page/read queries they call, and
 * `applyTeamFillChunk`'s fresh-read re-check.
 *
 * The RULES are pinned in lib/teamFill.test.ts, pure; this file proves the
 * plumbing agrees with them once real rows, a real subtree walk and real
 * chunking are involved — and the places the rows can move between preview
 * and apply (a card teamed in another tab, a team that stopped existing, a
 * re-sync adding cards) are skipped, or refused, rather than overwritten.
 *
 * Fixture shape follows selectorOptions.setSelectorOptionTeams.test.ts
 * (sport → setName → variantType → insert → parallel, raw inserts) and
 * cardChecklist.noTeam.test.ts (insertCard/insertTeam/insertPlayer). The
 * variantType carries `metadata.isBase` by default — the NB role tier 3
 * reads — and `seedTree(t, { isBase: false })` is the hand-built shape the
 * E2E flow makes, where a row NAMED "Base" is not the base.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import {
  TEAM_FILL_APPLY_CHUNK,
  TEAM_FILL_DRIFT_MESSAGE,
  TEAM_FILL_ID_CHUNK,
  TEAM_FILL_NODE_CHUNK,
} from "./teamFill";
import { TEAM_FILL_GROUP_NODE_CAP } from "./lib/teamFill";
import { MAX_CARD_TEAMS } from "./features/cardAttention";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_team_fill_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_team_fill_001",
  role: "admin",
};

const SIGNED_IN_IDENTITY = { subject: "user_team_fill_002" };

type T = ReturnType<typeof convexTest>;

/** sport → setName (season 2024) → variantType (isBase) → insert → parallel. */
async function seedTree(
  t: T,
  opts: { season?: string; isBase?: boolean } = {},
): Promise<{
  sportId: Id<"selectorOptions">;
  setNameId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
  insertId: Id<"selectorOptions">;
  parallelId: Id<"selectorOptions">;
}> {
  const season = opts.season ?? "2024";
  const isBase = opts.isBase ?? true;
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      ...(season ? { features: { season } } : {}),
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      ...(isBase ? { metadata: { isBase: true } } : {}),
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Stars",
      platformData: {},
      parentId: variantTypeId,
      children: [],
      lastUpdated: Date.now(),
    });
    const parallelId = await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value: "Gold",
      platformData: {},
      parentId: insertId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    await ctx.db.patch(variantTypeId, { children: [insertId] });
    await ctx.db.patch(insertId, { children: [parallelId] });
    return { sportId, setNameId, variantTypeId, insertId, parallelId };
  });
}

async function insertCard(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  opts: {
    cardNumber?: string;
    playerIds?: Array<Id<"players">>;
    teamOnCardIds?: Array<Id<"teams">>;
    teamNoneConfirmedAt?: number;
    pendingTeamNames?: string[];
    teamCheckDoneAt?: number;
    bscTeamName?: string;
    platformData?: Record<string, unknown>;
  } = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: opts.cardNumber ?? "1",
      cardName: "Test Card",
      platformData: opts.platformData ?? {},
      sortOrder: 0,
      lastUpdated: 1_700_000_000_000,
      ...(opts.playerIds ? { playerIds: opts.playerIds } : {}),
      ...(opts.teamOnCardIds ? { teamOnCardIds: opts.teamOnCardIds } : {}),
      ...(opts.teamNoneConfirmedAt !== undefined
        ? { teamNoneConfirmedAt: opts.teamNoneConfirmedAt }
        : {}),
      ...(opts.pendingTeamNames ? { pendingTeamNames: opts.pendingTeamNames } : {}),
      ...(opts.teamCheckDoneAt !== undefined
        ? { teamCheckDoneAt: opts.teamCheckDoneAt }
        : {}),
      ...(opts.bscTeamName !== undefined ? { bscTeamName: opts.bscTeamName } : {}),
    }),
  );
}

const getCard = (t: T, id: Id<"cardChecklist">) => t.run(async (ctx) => ctx.db.get(id));

async function insertTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeTeamName(name),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  teamYears: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      teamYears,
      lastUpdated: Date.now(),
    }),
  );
}

// ===========================================================================
// previewTeamFill
// ===========================================================================

describe("previewTeamFill", () => {
  test("counts and groups candidates across a mixed-level tree — same node, the parallel's original, the base card", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, insertId, parallelId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const reds = await insertTeam(t, sportId, "Cincinnati Reds");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", []);
    const bench = await insertPlayer(t, sportId, "Johnny Bench", []);

    // Base (isBase): Tatis teamed, and a teamless Tatis beside it → tier 1.
    await insertCard(t, variantTypeId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const underBase = await insertCard(t, variantTypeId, { cardNumber: "1", playerIds: [tatis] });
    // Stars (insert): Bench teamed on S-1; a teamless Tatis on S-2 → tier 3
    // (Stars has no Tatis evidence, and Bench's is a different player).
    await insertCard(t, insertId, { cardNumber: "S-1", playerIds: [bench], teamOnCardIds: [reds] });
    const starsTatis = await insertCard(t, insertId, { cardNumber: "S-2", playerIds: [tatis] });
    // Gold (parallel of Stars): S-1 copies Stars' teamed S-1 → tier 2; S-2's
    // original is teamless, so it falls through to the base card → tier 3.
    const goldBench = await insertCard(t, parallelId, { cardNumber: "S-1", playerIds: [bench] });
    const goldTatis = await insertCard(t, parallelId, { cardNumber: "S-2", playerIds: [tatis] });
    // A card directly under setName → tier 3.
    const underSet = await insertCard(t, setNameId, { cardNumber: "4", playerIds: [tatis] });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });

    expect(result.setYear).toBe(2024);
    expect(result.candidates).toBe(5);
    expect(result.fillable).toBe(5);
    expect(result.remaining).toBe(0);
    expect(result.byRule).toEqual({ samePlayerInSet: 5, oneTeamCareer: 0, oneStintInYear: 0 });
    // Riskiest first: the base-card reads (naming the nodes they write to,
    // in walk order), then the same-node find, then the parallel's original.
    expect(result.groups).toEqual([
      {
        playerNames: ["Fernando Tatis Jr."],
        teamNames: ["San Diego Padres"],
        rule: "samePlayerInSet",
        scope: "baseSet",
        mixed: false,
        nodeNames: ["2024 Topps", "Stars", "Gold"],
        nodeCount: 3,
        cardCount: 3,
      },
      {
        playerNames: ["Fernando Tatis Jr."],
        teamNames: ["San Diego Padres"],
        rule: "samePlayerInSet",
        scope: "sameNode",
        mixed: false,
        nodeNames: ["Base"],
        nodeCount: 1,
        cardCount: 1,
      },
      {
        playerNames: ["Johnny Bench"],
        teamNames: ["Cincinnati Reds"],
        rule: "samePlayerInSet",
        scope: "parallelOf",
        mixed: false,
        nodeNames: ["Gold"],
        nodeCount: 1,
        cardCount: 1,
      },
    ]);
    expect(result.groupsTotal).toBe(3);

    // Nothing written by a preview.
    for (const id of [underBase, starsTatis, goldBench, goldTatis, underSet]) {
      const row = await getCard(t, id);
      expect(row!.teamOnCardIds).toBeUndefined();
    }
  });

  test("the E2E shape — a hand-built 'Base' with no isBase role, two single-player cards, one teamed — fills by the same node", async () => {
    // set-fill-teams-from-teammate-card.yaml builds Insert › Base by hand;
    // its variantType is named "Base" but carries no `metadata.isBase`. The
    // teamless card fills from its teamed sibling under the same node, and
    // the ledger clause is the one the flow full-matches.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, insertId } = await seedTree(t, { isBase: false });
    const team = await insertTeam(t, sportId, "FTT Team");
    const ftp = await insertPlayer(t, sportId, "FTP Player", []);
    await insertCard(t, variantTypeId, { cardNumber: "781", playerIds: [ftp], teamOnCardIds: [team] });
    const teamless = await insertCard(t, variantTypeId, { cardNumber: "782", playerIds: [ftp] });
    // The same player, teamless, under the insert: with no base flagged there
    // is no tier that reaches across nodes, so it stays.
    const onInsert = await insertCard(t, insertId, { cardNumber: "S-1", playerIds: [ftp] });

    const preview = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(preview.fillable).toBe(1);
    expect(preview.remaining).toBe(1);
    expect(preview.byRule).toEqual({ samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 });
    expect(preview.groups).toEqual([
      {
        playerNames: ["FTP Player"],
        teamNames: ["FTT Team"],
        rule: "samePlayerInSet",
        scope: "sameNode",
        mixed: false,
        nodeNames: ["Base"],
        nodeCount: 1,
        cardCount: 1,
      },
    ]);

    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
      expectedFillable: preview.fillable,
    });
    expect(result).toEqual({
      applied: 1,
      skipped: 0,
      byRule: { samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 },
    });
    expect((await getCard(t, teamless))!.teamOnCardIds).toEqual([team]);
    expect((await getCard(t, onInsert))!.teamOnCardIds).toBeUndefined();
  });

  test("a teamed card on ANOTHER insert is never evidence: the base card decides, or nothing does", async () => {
    // Favre: a Jet on one insert, teamless on another. With the base flagged
    // and the base card a Packer, the base wins; with the flag gone, the
    // other insert still counts for nothing and the card remains.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, insertId } = await seedTree(t);
    const otherInsertId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Legends",
        platformData: {},
        parentId: variantTypeId,
        children: [],
        lastUpdated: Date.now(),
      });
      const parent = await ctx.db.get(variantTypeId);
      await ctx.db.patch(variantTypeId, { children: [...(parent?.children ?? []), id] });
      return id;
    });
    const packers = await insertTeam(t, sportId, "Green Bay Packers");
    const jets = await insertTeam(t, sportId, "New York Jets");
    const favre = await insertPlayer(t, sportId, "Brett Favre", []);
    await insertCard(t, otherInsertId, { cardNumber: "L-4", playerIds: [favre], teamOnCardIds: [jets] });
    await insertCard(t, variantTypeId, { cardNumber: "4", playerIds: [favre], teamOnCardIds: [packers] });
    const target = await insertCard(t, insertId, { cardNumber: "S-4", playerIds: [favre] });

    const withBase = await asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId });
    expect(withBase.fillable).toBe(1);
    expect(withBase.groups[0]).toMatchObject({
      playerNames: ["Brett Favre"],
      teamNames: ["Green Bay Packers"],
      scope: "baseSet",
      nodeNames: ["Stars"],
    });

    await t.run(async (ctx) => ctx.db.patch(variantTypeId, { metadata: {} }));
    const withoutBase = await asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId });
    expect(withoutBase.fillable).toBe(0);
    expect(withoutBase.remaining).toBe(1);
    expect((await getCard(t, target))!.teamOnCardIds).toBeUndefined();
  });

  test("two variantTypes both flagged isBase: the base is ambiguous and tier 3 is skipped", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, insertId } = await seedTree(t);
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base Too",
        platformData: {},
        metadata: { isBase: true },
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
      const set = await ctx.db.get(setNameId);
      await ctx.db.patch(setNameId, { children: [...(set?.children ?? []), id] });
    });
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", []);
    await insertCard(t, variantTypeId, { cardNumber: "1", playerIds: [tatis], teamOnCardIds: [padres] });
    await insertCard(t, insertId, { cardNumber: "S-1", playerIds: [tatis] });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId });
    expect(result.fillable).toBe(0);
    expect(result.remaining).toBe(1);
  });

  test("a combo card takes each player's own team — base for one, career for the other — and is flagged mixed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, insertId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const reds = await insertTeam(t, sportId, "Cincinnati Reds");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", []);
    const bench = await insertPlayer(t, sportId, "Johnny Bench", [
      { teamId: reds, fromYear: 1967, toYear: 1983 },
    ]);
    await insertCard(t, variantTypeId, { cardNumber: "1", playerIds: [tatis], teamOnCardIds: [padres] });
    const combo = await insertCard(t, insertId, { cardNumber: "D-1", playerIds: [tatis, bench] });

    const preview = await asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId });
    expect(preview.byRule).toEqual({ samePlayerInSet: 0, oneTeamCareer: 1, oneStintInYear: 0 });
    expect(preview.groups).toEqual([
      {
        playerNames: ["Fernando Tatis Jr.", "Johnny Bench"],
        teamNames: expect.arrayContaining(["San Diego Padres", "Cincinnati Reds"]),
        rule: "oneTeamCareer",
        scope: "career",
        mixed: true,
        nodeNames: ["Stars"],
        nodeCount: 1,
        cardCount: 1,
      },
    ]);

    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
      expectedFillable: 1,
    });
    expect(result.applied).toBe(1);
    const row = await getCard(t, combo);
    expect(new Set(row!.teamOnCardIds)).toEqual(new Set([padres, reds]));
  });

  test("career groups come first, and a base-card group's node names are capped with the count beside", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const reds = await insertTeam(t, sportId, "Cincinnati Reds");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", []);
    const bench = await insertPlayer(t, sportId, "Johnny Bench", [
      { teamId: reds, fromYear: 1967, toYear: 1983 },
    ]);

    // Tatis's base card under the (isBase) variantType; candidates under
    // MORE inserts than the node cap, one card each — a big baseSet group.
    await insertCard(t, variantTypeId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const insertNames: string[] = [];
    for (let i = 0; i < TEAM_FILL_GROUP_NODE_CAP + 2; i += 1) {
      const name = `Insert ${i}`;
      insertNames.push(name);
      const insertId = await t.run(async (ctx) =>
        ctx.db.insert("selectorOptions", {
          level: "insert",
          value: name,
          platformData: {},
          parentId: variantTypeId,
          children: [],
          lastUpdated: Date.now(),
        }),
      );
      await t.run(async (ctx) => {
        const parent = await ctx.db.get(variantTypeId);
        await ctx.db.patch(variantTypeId, { children: [...(parent?.children ?? []), insertId] });
      });
      await insertCard(t, insertId, { cardNumber: `i${i}`, playerIds: [tatis] });
    }
    // One rule B card — a single card, yet it lists first.
    await insertCard(t, setNameId, { cardNumber: "b", playerIds: [bench] });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.groups.map((g) => [g.rule, g.scope, g.cardCount])).toEqual([
      ["oneTeamCareer", "career", 1],
      ["samePlayerInSet", "baseSet", TEAM_FILL_GROUP_NODE_CAP + 2],
    ]);
    const borrow = result.groups[1];
    expect(borrow.nodeNames).toHaveLength(TEAM_FILL_GROUP_NODE_CAP);
    expect(insertNames).toEqual(expect.arrayContaining(borrow.nodeNames));
    expect(borrow.nodeCount).toBe(TEAM_FILL_GROUP_NODE_CAP + 2);
    expect(result.groups[0]).toMatchObject({
      playerNames: ["Johnny Bench"],
      teamNames: ["Cincinnati Reds"],
      nodeNames: ["2024 Topps"],
      nodeCount: 1,
    });
  });

  test("refuses a non-setName root with the exact message", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedTree(t);
    await expect(
      asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: variantTypeId }),
    ).rejects.toThrow(/Fill teams from the set row, not a variant or parallel\./);
  });

  test("refuses a missing root with the exact message", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { setNameId } = await seedTree(t);
    await t.run(async (ctx) => ctx.db.delete(setNameId));
    await expect(
      asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId }),
    ).rejects.toThrow(/That set no longer exists\./);
  });

  test("refuses a signed-in non-admin and an anonymous caller, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    const cardId = await insertCard(t, setNameId, { playerIds: [tatis] });

    await expect(
      t
        .withIdentity(SIGNED_IN_IDENTITY)
        .action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId }),
    ).rejects.toThrow();
    await expect(
      t.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId }),
    ).rejects.toThrow();

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("teamNoneConfirmedAt and pending-name cards are never counted as candidates", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const confirmed = await insertCard(t, setNameId, {
      cardNumber: "confirmed",
      playerIds: [tatis],
      teamNoneConfirmedAt: 1_700_000_000_000,
    });
    const pending = await insertCard(t, setNameId, {
      cardNumber: "pending",
      playerIds: [tatis],
      pendingTeamNames: ["Some Team"],
    });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.candidates).toBe(0);
    expect(result.fillable).toBe(0);

    for (const id of [confirmed, pending]) {
      const row = await getCard(t, id);
      expect(row!.teamOnCardIds).toBeUndefined();
    }
  });

  test("a dangling team id never fills, and lands in remaining", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const ghostTeam = await insertTeam(t, sportId, "Ghost Team");
    const player = await insertPlayer(t, sportId, "Deleted Team Guy", [
      { teamId: ghostTeam, fromYear: 2000, toYear: 2005 },
    ]);
    await t.run(async (ctx) => ctx.db.delete(ghostTeam));
    const cardId = await insertCard(t, setNameId, { playerIds: [player] });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.candidates).toBe(1);
    expect(result.fillable).toBe(0);
    expect(result.remaining).toBe(1);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("a team belonging to another sport never fills", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const otherSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Basketball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const wrongSportTeam = await insertTeam(t, otherSportId, "Off Sport Team");
    const player = await insertPlayer(t, sportId, "Cross Sport Guy", [
      { teamId: wrongSportTeam, fromYear: 2000, toYear: 2030 },
    ]);
    const cardId = await insertCard(t, setNameId, { playerIds: [player] });

    const result = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(result.fillable).toBe(0);
    expect(result.remaining).toBe(1);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });
});

// ===========================================================================
// applyTeamFill
// ===========================================================================

describe("applyTeamFill", () => {
  test("writes teamOnCardIds + lastUpdated, clears bscTeamName, leaves teamCheckDoneAt/teamNoneConfirmedAt alone", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const cardId = await insertCard(t, setNameId, {
      cardNumber: "1",
      playerIds: [tatis],
      teamCheckDoneAt: 1_690_000_000_000,
      bscTeamName: "Marketplace says: Padres",
    });

    const before = Date.now();
    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
      expectedFillable: 1,
    });
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.byRule.samePlayerInSet).toBe(1);

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([padres]);
    expect(row!.lastUpdated).toBeGreaterThanOrEqual(before);
    expect(row!.bscTeamName).toBeUndefined();
    expect(row!.teamCheckDoneAt).toBe(1_690_000_000_000);
    expect(row!.teamNoneConfirmedAt).toBeUndefined();
  });

  test("refuses a signed-in non-admin and an anonymous caller, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const cardId = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [tatis] });

    await expect(
      t
        .withIdentity(SIGNED_IN_IDENTITY)
        .action(api.teamFill.applyTeamFill, { selectorOptionId: setNameId, expectedFillable: 1 }),
    ).rejects.toThrow();
    await expect(
      t.action(api.teamFill.applyTeamFill, { selectorOptionId: setNameId, expectedFillable: 1 }),
    ).rejects.toThrow();

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("refuses a non-setName root and a missing root the same way preview does", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { variantTypeId } = await seedTree(t);
    await expect(
      asAdmin.action(api.teamFill.applyTeamFill, {
        selectorOptionId: variantTypeId,
        expectedFillable: 0,
      }),
    ).rejects.toThrow(/Fill teams from the set row, not a variant or parallel\./);
  });

  test("refuses to fill MORE cards than the preview promised, writing nothing", async () => {
    // The operator previewed 1 fillable; a re-sync (or a teammate) added a
    // second teamless card before they pressed Yes. The recomputed plan is
    // bigger than the number they confirmed, so the apply is refused whole.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const first = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [tatis] });

    const preview = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(preview.fillable).toBe(1);

    const second = await insertCard(t, setNameId, { cardNumber: "2", playerIds: [tatis] });

    await expect(
      asAdmin.action(api.teamFill.applyTeamFill, {
        selectorOptionId: setNameId,
        expectedFillable: preview.fillable,
      }),
    ).rejects.toThrow(TEAM_FILL_DRIFT_MESSAGE);

    for (const id of [first, second]) {
      const row = await getCard(t, id);
      expect(row!.teamOnCardIds).toBeUndefined();
    }
  });

  test("fills FEWER cards than the preview promised without complaint — the toast carries the real count", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const dodgers = await insertTeam(t, sportId, "Los Angeles Dodgers");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const first = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [tatis] });
    const second = await insertCard(t, setNameId, { cardNumber: "2", playerIds: [tatis] });

    const preview = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(preview.fillable).toBe(2);

    // Someone teams one of them by hand in between.
    await t.run(async (ctx) => ctx.db.patch(second, { teamOnCardIds: [dodgers] }));

    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
      expectedFillable: preview.fillable,
    });
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0); // never entered the recomputed plan at all

    expect((await getCard(t, first))!.teamOnCardIds).toEqual([padres]);
    expect((await getCard(t, second))!.teamOnCardIds).toEqual([dodgers]); // stands
  });

  test("a card teamed after the plan was computed is skipped at the chunk's fresh re-check, not overwritten", async () => {
    // `applyTeamFill` recomputes the whole plan from a fresh read, so a card
    // teamed before that recompute simply never enters the plan at all — the
    // race this docstring means is narrower: between the plan being computed
    // and `applyTeamFillChunk` actually patching THIS card (another tab, a
    // NEO-277 cascade landing mid-apply). That window is exactly what
    // `applyTeamFillChunk`'s own fresh `ctx.db.get` re-check exists for, so
    // it is exercised directly here rather than through the whole action.
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const dodgers = await insertTeam(t, sportId, "Los Angeles Dodgers");
    const player = await insertPlayer(t, sportId, "Race Guy", []);
    const cardId = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [player] });

    // Simulate the race: something else teams the card after the fill was
    // decided but before the chunk mutation reaches it.
    await t.run(async (ctx) => ctx.db.patch(cardId, { teamOnCardIds: [dodgers] }));

    const result = await t.mutation(internal.teamFill.applyTeamFillChunk, {
      fills: [{ cardId, teamIds: [padres] }],
    });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);

    // Never overwritten — the operator's own team stands.
    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toEqual([dodgers]);
  });

  test("writes a parallel's team from the card it copies, and a base-card read onto an insert", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, insertId, parallelId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const reds = await insertTeam(t, sportId, "Cincinnati Reds");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", []);
    const bench = await insertPlayer(t, sportId, "Johnny Bench", []);
    const gwynn = await insertPlayer(t, sportId, "Tony Gwynn", []);
    await insertCard(t, variantTypeId, { cardNumber: "1", playerIds: [tatis], teamOnCardIds: [padres] });
    await insertCard(t, insertId, { cardNumber: "S-1", playerIds: [bench], teamOnCardIds: [reds] });
    const goldBench = await insertCard(t, parallelId, { cardNumber: "S-1", playerIds: [bench] });
    const starsTatis = await insertCard(t, insertId, { cardNumber: "S-2", playerIds: [tatis] });
    // Same number as Gold S-1 but a different player: a different card, so
    // Gold S-1 still has exactly one original.
    await insertCard(t, insertId, { cardNumber: "S-1", playerIds: [gwynn], teamOnCardIds: [padres] });

    const before = await asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId });
    expect(before.groups.map((g) => [g.scope, g.playerNames[0]])).toEqual([
      ["baseSet", "Fernando Tatis Jr."],
      ["parallelOf", "Johnny Bench"],
    ]);

    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
      expectedFillable: before.fillable,
    });
    expect(result).toEqual({
      applied: 2,
      skipped: 0,
      byRule: { samePlayerInSet: 2, oneTeamCareer: 0, oneStintInYear: 0 },
    });
    expect((await getCard(t, goldBench))!.teamOnCardIds).toEqual([reds]);
    expect((await getCard(t, starsTatis))!.teamOnCardIds).toEqual([padres]);

    const preview = await asAdmin.action(api.teamFill.previewTeamFill, { selectorOptionId: setNameId });
    expect(preview.fillable).toBe(0); // both written; the preview now finds nothing
  });

  test("more fills than one apply chunk: every one is still applied", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const tatis = await insertPlayer(t, sportId, "Fernando Tatis Jr.", [
      { teamId: padres, fromYear: 2019 },
    ]);
    await insertCard(t, setNameId, { cardNumber: "ev", playerIds: [tatis], teamOnCardIds: [padres] });
    const total = TEAM_FILL_APPLY_CHUNK + 7;
    const cardIds: Array<Id<"cardChecklist">> = [];
    for (let i = 0; i < total; i += 1) {
      cardIds.push(await insertCard(t, setNameId, { cardNumber: `c${i}`, playerIds: [tatis] }));
    }

    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
      expectedFillable: total,
    });
    expect(result.applied).toBe(total);
    expect(result.skipped).toBe(0);

    for (const id of cardIds) {
      const row = await getCard(t, id);
      expect(row!.teamOnCardIds).toEqual([padres]);
    }
  });
});

// ===========================================================================
// listTeamFillSubtree — the nodes and their roles
// ===========================================================================

describe("listTeamFillSubtree", () => {
  test("returns the root with its level, parent, isBase role and children", async () => {
    const t = convexTest(schema, modules);
    const { setNameId, sportId, variantTypeId } = await seedTree(t);
    const result = await t.query(internal.teamFill.listTeamFillSubtree, {
      selectorOptionId: setNameId,
    });
    expect(result.root).toEqual({
      _id: setNameId,
      level: "setName",
      parentId: sportId,
      isBase: false,
      childIds: [variantTypeId],
    });
    expect(result.setYear).toBe(2024);
    expect(result.sportId).toBe(sportId);
  });

  test("refuses a root that is not a setName row", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t);
    await expect(
      t.query(internal.teamFill.listTeamFillSubtree, { selectorOptionId: variantTypeId }),
    ).rejects.toThrow(/not a variant or parallel/i);
  });
});

// ===========================================================================
// readTeamFillNodes — the bounded subtree walk (NEO-296)
// ===========================================================================

describe("readTeamFillNodes", () => {
  test("projects each id once, with the children the next step follows", async () => {
    const t = convexTest(schema, modules);
    const { setNameId, variantTypeId, insertId, parallelId } = await seedTree(t);
    const rows = await t.query(internal.teamFill.readTeamFillNodes, {
      nodeIds: [variantTypeId, insertId, parallelId],
    });
    expect(rows).toEqual([
      { _id: variantTypeId, level: "variantType", parentId: setNameId, isBase: true, childIds: [insertId] },
      { _id: insertId, level: "insert", parentId: variantTypeId, isBase: false, childIds: [parallelId] },
      { _id: parallelId, level: "parallel", parentId: insertId, isBase: false, childIds: [] },
    ]);
  });

  test("isBase is the metadata ROLE, never the display value", async () => {
    const t = convexTest(schema, modules);
    const { variantTypeId } = await seedTree(t, { isBase: false });
    const [base] = await t.query(internal.teamFill.readTeamFillNodes, {
      nodeIds: [variantTypeId],
    });
    expect(base).toMatchObject({ level: "variantType", isBase: false });
    // The row IS named "Base"; that is exactly what must not count.
    const row = await t.run(async (ctx) => ctx.db.get(variantTypeId));
    expect(row!.value).toBe("Base");
  });

  test("a dangling child id is omitted rather than answered as a node", async () => {
    const t = convexTest(schema, modules);
    const { insertId, parallelId } = await seedTree(t);
    await t.run(async (ctx) => ctx.db.delete(parallelId));
    const rows = await t.query(internal.teamFill.readTeamFillNodes, {
      nodeIds: [insertId, parallelId],
    });
    expect(rows.map((row) => row._id)).toEqual([insertId]);
  });

  test("refuses more ids than TEAM_FILL_NODE_CHUNK rather than answering short", async () => {
    const t = convexTest(schema, modules);
    const { setNameId } = await seedTree(t);
    const tooMany = Array.from({ length: TEAM_FILL_NODE_CHUNK + 1 }, () => setNameId);
    await expect(
      t.query(internal.teamFill.readTeamFillNodes, { nodeIds: tooMany }),
    ).rejects.toThrow(new RegExp(`chunks of ${TEAM_FILL_NODE_CHUNK}`));
  });

  test("a subtree wider than one chunk is walked in full by preview and apply", async () => {
    // The node walk pages at TEAM_FILL_NODE_CHUNK; a card sitting on a node in
    // the SECOND page must be planned and written exactly like one in the
    // first. Without the page loop the preview would silently promise less
    // than the set holds.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, insertId } = await seedTree(t);
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const gwynn = await insertPlayer(t, sportId, "Tony Gwynn");

    const extra = await t.run(async (ctx) => {
      const ids: Array<Id<"selectorOptions">> = [];
      for (let i = 0; i < TEAM_FILL_NODE_CHUNK + 4; i += 1) {
        ids.push(
          await ctx.db.insert("selectorOptions", {
            level: "parallel",
            value: `Refractor ${i}`,
            platformData: {},
            parentId: insertId,
            children: [],
            lastUpdated: Date.now(),
          }),
        );
      }
      const parent = (await ctx.db.get(insertId))!;
      await ctx.db.patch(insertId, { children: [...(parent.children ?? []), ...ids] });
      return ids;
    });
    const lastNode = extra[extra.length - 1];

    // Evidence on the base checklist, the teamless card on the very last node.
    await insertCard(t, variantTypeId, { cardNumber: "1", playerIds: [gwynn], teamOnCardIds: [padres] });
    const target = await insertCard(t, lastNode, { cardNumber: "1", playerIds: [gwynn] });

    const preview = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(preview.fillable).toBe(1);

    const result = await asAdmin.action(api.teamFill.applyTeamFill, {
      selectorOptionId: setNameId,
      expectedFillable: preview.fillable,
    });
    expect(result.applied).toBe(1);
    expect((await getCard(t, target))!.teamOnCardIds).toEqual([padres]);
  });

  test("a children cycle is visited once rather than walked forever", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId, variantTypeId, parallelId } = await seedTree(t);
    // A hand-edited `children` pointing back up the tree. The walk's queued
    // set is what keeps this a finite read rather than a hang.
    await t.run(async (ctx) => ctx.db.patch(parallelId, { children: [setNameId] }));
    const padres = await insertTeam(t, sportId, "San Diego Padres");
    const gwynn = await insertPlayer(t, sportId, "Tony Gwynn");
    await insertCard(t, variantTypeId, { cardNumber: "1", playerIds: [gwynn], teamOnCardIds: [padres] });
    const target = await insertCard(t, parallelId, { cardNumber: "1", playerIds: [gwynn] });

    const preview = await asAdmin.action(api.teamFill.previewTeamFill, {
      selectorOptionId: setNameId,
    });
    expect(preview.fillable).toBe(1);
    expect(preview.candidates).toBe(1);
    expect(target).toBeDefined();
  });
});

// ===========================================================================
// readTeamFillCards — the page walk
// ===========================================================================

describe("readTeamFillCards", () => {
  test("a small per-call budget across several leaves visits every card exactly once", async () => {
    const t = convexTest(schema, modules);
    const { setNameId, variantTypeId, insertId, parallelId } = await seedTree(t);
    const nodeIds = [setNameId, variantTypeId, insertId, parallelId];

    const expectedIds = new Set<string>();
    for (const nodeId of nodeIds) {
      for (let i = 0; i < 3; i += 1) {
        const id = await insertCard(t, nodeId, { cardNumber: `${nodeId}-${i}` });
        expectedIds.add(id);
      }
    }

    const seenIds = new Set<string>();
    let nodeIndex = 0;
    let cursor: number | undefined;
    let iterations = 0;
    for (;;) {
      iterations += 1;
      expect(iterations).toBeLessThan(100); // guard against an infinite loop bug
      const page = await t.query(internal.teamFill.readTeamFillCards, {
        nodeIds,
        nodeIndex,
        ...(cursor !== undefined ? { cursor } : {}),
        budget: 2,
      });
      for (const card of page.cards) {
        expect(seenIds.has(card._id)).toBe(false); // never visited twice
        seenIds.add(card._id);
      }
      if (page.done) {
        expect(page.cursor).toBeNull();
        break;
      }
      nodeIndex = page.nodeIndex;
      cursor = page.cursor ?? undefined;
    }

    expect(seenIds).toEqual(expectedIds);
  });

  test("names every node it visits by its display value, once, beside its season", async () => {
    const t = convexTest(schema, modules);
    const { setNameId, variantTypeId, insertId, parallelId } = await seedTree(t);
    const nodeIds = [setNameId, variantTypeId, insertId, parallelId];
    for (const nodeId of nodeIds) await insertCard(t, nodeId, { cardNumber: `${nodeId}-0` });

    const page = await t.query(internal.teamFill.readTeamFillCards, {
      nodeIds,
      nodeIndex: 0,
      budget: 100,
    });
    expect(page.done).toBe(true);
    expect(page.nameByNodeId).toEqual([
      { nodeId: setNameId, name: "2024 Topps" },
      { nodeId: variantTypeId, name: "Base" },
      { nodeId: insertId, name: "Stars" },
      { nodeId: parallelId, name: "Gold" },
    ]);
    expect(page.yearByNodeId.map((entry) => entry.nodeId)).toEqual(nodeIds);
    expect(page.yearByNodeId[0].year).toBe(2024);
  });

  test("a non-finite or sub-one budget is clamped to one card, so the walk still advances", async () => {
    const t = convexTest(schema, modules);
    const { setNameId } = await seedTree(t);
    await insertCard(t, setNameId, { cardNumber: "1" });
    await insertCard(t, setNameId, { cardNumber: "2" });

    for (const budget of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 0.25]) {
      const page = await t.query(internal.teamFill.readTeamFillCards, {
        nodeIds: [setNameId],
        nodeIndex: 0,
        budget,
      });
      expect(page.cards).toHaveLength(1);
      expect(page.done).toBe(false);
      expect(page.cursor).not.toBeNull();
    }
  });

  test("projects the card number, which tier 2 matches on", async () => {
    const t = convexTest(schema, modules);
    const { setNameId } = await seedTree(t);
    const id = await insertCard(t, setNameId, { cardNumber: "S-7" });
    const page = await t.query(internal.teamFill.readTeamFillCards, {
      nodeIds: [setNameId],
      nodeIndex: 0,
      budget: 10,
    });
    expect(page.cards.find((card) => card._id === id)!.cardNumber).toBe("S-7");
  });

  test("projects hasPendingTeamNames as a boolean, never the strings themselves", async () => {
    const t = convexTest(schema, modules);
    const { setNameId } = await seedTree(t);
    const pending = await insertCard(t, setNameId, {
      cardNumber: "p",
      pendingTeamNames: ["Some Team"],
    });
    const bare = await insertCard(t, setNameId, { cardNumber: "b" });

    const page = await t.query(internal.teamFill.readTeamFillCards, {
      nodeIds: [setNameId],
      nodeIndex: 0,
      budget: 10,
    });
    const byId = new Map(page.cards.map((card) => [card._id, card]));
    expect(byId.get(pending)!.hasPendingTeamNames).toBe(true);
    expect(byId.get(bare)!.hasPendingTeamNames).toBe(false);
    expect("pendingTeamNames" in byId.get(pending)!).toBe(false);
  });
});

// ===========================================================================
// readTeamFillPlayers / readTeamFillTeams — chunk refusal
// ===========================================================================

describe("readTeamFillPlayers / readTeamFillTeams", () => {
  test("refuse more ids than TEAM_FILL_ID_CHUNK", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedTree(t);
    // The length check runs before dedup, so one real id repeated past the
    // validator (which only checks each entry is ID-shaped) is enough.
    const player = await insertPlayer(t, sportId, "Repeat Guy", []);
    const tooMany = Array.from({ length: TEAM_FILL_ID_CHUNK + 1 }, () => player);
    await expect(
      t.query(internal.teamFill.readTeamFillPlayers, { playerIds: tooMany }),
    ).rejects.toThrow(new RegExp(`chunks of ${TEAM_FILL_ID_CHUNK}`));

    const team = await insertTeam(t, sportId, "Repeat Team");
    const tooManyTeams = Array.from({ length: TEAM_FILL_ID_CHUNK + 1 }, () => team);
    await expect(
      t.query(internal.teamFill.readTeamFillTeams, { teamIds: tooManyTeams }),
    ).rejects.toThrow(new RegExp(`chunks of ${TEAM_FILL_ID_CHUNK}`));
  });
});

// ===========================================================================
// applyTeamFillChunk — internal mutation guards
// ===========================================================================

describe("applyTeamFillChunk", () => {
  test("refuses more fills than TEAM_FILL_APPLY_CHUNK", async () => {
    const t = convexTest(schema, modules);
    const { setNameId } = await seedTree(t);
    // The length check runs before any card is read, so one real id repeated
    // past the validator's ID-shape check is enough.
    const cardId = await insertCard(t, setNameId, { cardNumber: "1" });
    const fills = Array.from({ length: TEAM_FILL_APPLY_CHUNK + 1 }, () => ({
      cardId,
      teamIds: [] as Array<Id<"teams">>,
    }));
    await expect(
      t.mutation(internal.teamFill.applyTeamFillChunk, { fills }),
    ).rejects.toThrow(new RegExp(`chunks of ${TEAM_FILL_APPLY_CHUNK}`));
  });

  test("skips a fill naming more teams than MAX_CARD_TEAMS, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const player = await insertPlayer(t, sportId, "Many Teams Guy", []);
    const cardId = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [player] });
    const teamIds: Array<Id<"teams">> = [];
    for (let i = 0; i < MAX_CARD_TEAMS + 1; i += 1) {
      teamIds.push(await insertTeam(t, sportId, `Team ${i}`));
    }

    const result = await t.mutation(internal.teamFill.applyTeamFillChunk, {
      fills: [{ cardId, teamIds }],
    });
    expect(result).toEqual({ applied: 0, skipped: 1 });

    const row = await getCard(t, cardId);
    expect(row!.teamOnCardIds).toBeUndefined();
  });

  test("skips a fill naming an empty team list, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId } = await seedTree(t);
    const player = await insertPlayer(t, sportId, "No Team Guy", []);
    const cardId = await insertCard(t, setNameId, { cardNumber: "1", playerIds: [player] });

    const result = await t.mutation(internal.teamFill.applyTeamFillChunk, {
      fills: [{ cardId, teamIds: [] }],
    });
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });
});
