/**
 * NEO-490 — `applyPublishedChecklistPairs`: the operator's own checklist links,
 * answered the way `fetchCardChecklist` answers its own (the pure rules are in
 * `lib/checklists/apply-published-row.test.ts`). Pinned here: the admin gate,
 * the row bound, the refusal of a set with no sport, comma-text resolution,
 * the empty answer, and that nothing is written.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_PUBLISHED_CHECKLIST_ROWS } from "./selectorOptions";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_pairs_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_pairs_001",
  role: "admin",
};
const MEMBER = {
  subject: "member_pairs_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|member_pairs_001",
  role: "member",
};

async function seedSet(t: ReturnType<typeof convexTest>): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(yearId, { children: [setNameId] });
    return setNameId;
  });
}

type Pair = {
  card: { players: string[]; teams: string[] };
  row: { number: string; players: string[]; teams: string[] };
};
const pair = (card: Pair["card"], row: Partial<Pair["row"]> = {}): Pair => ({
  card,
  row: { number: "1", players: [], teams: [], ...row },
});

async function tableCounts(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    selectorOptions: (await ctx.db.query("selectorOptions").collect()).length,
    candidates: (await ctx.db.query("checklistCandidates").collect()).length,
    players: (await ctx.db.query("players").collect()).length,
    teams: (await ctx.db.query("teams").collect()).length,
  }));
}

describe("applyPublishedChecklistPairs: access", () => {
  test("refuses an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    const id = await seedSet(t);
    await expect(
      t.action(api.publishedChecklistPairs.applyPublishedChecklistPairs, {
        selectorOptionId: id,
        pairs: [],
      }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("refuses a signed-in caller who is not an admin", async () => {
    const t = convexTest(schema, modules);
    const id = await seedSet(t);
    await expect(
      t.withIdentity(MEMBER).action(api.publishedChecklistPairs.applyPublishedChecklistPairs, {
        selectorOptionId: id,
        pairs: [pair({ players: [], teams: [] })],
      }),
    ).rejects.toThrow(/admin access required/i);
  });
});

describe("applyPublishedChecklistPairs: the set must have a sport", () => {
  /** A setName row with no parent: no sport above it. */
  async function seedOrphanSet(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "2024 Topps",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
  }

  test("refuses a set with no sport above it, before answering anything", async () => {
    const t = convexTest(schema, modules);
    const id = await seedOrphanSet(t);
    const before = await tableCounts(t);
    await expect(
      t.withIdentity(ADMIN).action(api.publishedChecklistPairs.applyPublishedChecklistPairs, {
        selectorOptionId: id,
        pairs: [pair({ players: [], teams: [] }, { players: ["A One"], teams: ["Phillies, Braves"] })],
      }),
    ).rejects.toThrow(/applyPublishedChecklistPairs: the set has no sport above it/);
    expect(await tableCounts(t)).toEqual(before);
  });

  test("refuses an id that names no row, even with no pairs", async () => {
    const t = convexTest(schema, modules);
    const id = await seedOrphanSet(t);
    await t.run(async (ctx) => ctx.db.delete(id));
    await expect(
      t.withIdentity(ADMIN).action(api.publishedChecklistPairs.applyPublishedChecklistPairs, {
        selectorOptionId: id,
        pairs: [],
      }),
    ).rejects.toThrow(/the set has no sport above it/);
  });

  test("the refusal is a ConvexError, so the dialog can show its message", async () => {
    const t = convexTest(schema, modules);
    const id = await seedOrphanSet(t);
    const err = await t
      .withIdentity(ADMIN)
      .action(api.publishedChecklistPairs.applyPublishedChecklistPairs, {
        selectorOptionId: id,
        pairs: [pair({ players: [], teams: [] })],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
  });
});

describe("applyPublishedChecklistPairs: answers", () => {
  const call = async (pairs: Pair[]) => {
    const t = convexTest(schema, modules);
    const id = await seedSet(t);
    const before = await tableCounts(t);
    const answers = await t
      .withIdentity(ADMIN)
      .action(api.publishedChecklistPairs.applyPublishedChecklistPairs, {
        selectorOptionId: id,
        pairs,
      });
    return { t, answers, before };
  };

  test("refuses more than MAX_PUBLISHED_CHECKLIST_ROWS pairs", async () => {
    const t = convexTest(schema, modules);
    const id = await seedSet(t);
    const pairs = Array.from({ length: MAX_PUBLISHED_CHECKLIST_ROWS + 1 }, () =>
      pair({ players: [], teams: [] }),
    );
    await expect(
      t.withIdentity(ADMIN).action(api.publishedChecklistPairs.applyPublishedChecklistPairs, {
        selectorOptionId: id,
        pairs,
      }),
    ).rejects.toThrow(new RegExp(`limit is ${MAX_PUBLISHED_CHECKLIST_ROWS}`));
  });

  test("no pairs answers an empty list", async () => {
    const { answers } = await call([]);
    expect(answers).toEqual([]);
  });

  test("a row naming a team answers it with teamLookup checklist", async () => {
    const { answers } = await call([
      pair({ players: ["A One"], teams: [] }, { players: ["A One"], teams: ["Boston Red Sox"] }),
    ]);
    expect(answers).toEqual([{ teams: ["Boston Red Sox"], teamLookup: "checklist" }]);
  });

  test("a comma team text is resolved and split", async () => {
    const { answers } = await call([
      pair({ players: ["A One"], teams: [] }, { players: ["A One"], teams: ["Phillies, Braves"] }),
    ]);
    expect(answers).toEqual([{ teams: ["Phillies", "Braves"], teamLookup: "checklist" }]);
  });

  test("a row that changes nothing comes back as {}", async () => {
    const { answers } = await call([
      pair({ players: ["A One"], teams: ["Boston Red Sox"] }, { players: ["A One"], teams: [] }),
    ]);
    expect(answers).toEqual([{}]);
  });

  test("a card with no players is filled from the row", async () => {
    const { answers } = await call([pair({ players: [], teams: [] }, { players: ["Juan Soto"] })]);
    expect(answers).toEqual([{ players: ["Juan Soto"] }]);
  });

  test("a team disagreement keeps the card's team and returns the conflict", async () => {
    const { answers } = await call([
      pair(
        { players: ["A One"], teams: ["New York Mets"] },
        { players: ["A One"], teams: ["Philadelphia Phillies"] },
      ),
    ]);
    expect(answers).toEqual([
      {
        checklistConflict: {
          teams: { marketplace: ["New York Mets"], checklist: ["Philadelphia Phillies"] },
        },
      },
    ]);
  });

  test("answers come back in pair order", async () => {
    const { answers } = await call([
      pair({ players: [], teams: [] }, { teams: ["Boston Red Sox"] }),
      pair({ players: [], teams: [] }, { teams: ["Chicago Cubs"] }),
    ]);
    expect(answers.map((a) => a.teams)).toEqual([["Boston Red Sox"], ["Chicago Cubs"]]);
  });

  test("a card over the team cap is refused", async () => {
    const t = convexTest(schema, modules);
    const id = await seedSet(t);
    await expect(
      t.withIdentity(ADMIN).action(api.publishedChecklistPairs.applyPublishedChecklistPairs, {
        selectorOptionId: id,
        pairs: [pair({ players: [], teams: Array.from({ length: 9 }, (_, i) => `T${i}`) })],
      }),
    ).rejects.toThrow(/Linked card 1 names 9 teams/);
  });

  test("nothing is written", async () => {
    const { t, before } = await call([
      pair({ players: [], teams: [] }, { players: ["A One"], teams: ["Phillies, Braves"] }),
      pair({ players: ["B Two"], teams: ["New York Mets"] }, { players: ["C Three"], teams: ["Cubs"] }),
    ]);
    expect(await tableCounts(t)).toEqual(before);
  });
});
