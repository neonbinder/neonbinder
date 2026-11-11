/**
 * PR 451 (NEO-478) — what `commitCardChecklist` does with the publisher
 * checklist's footprint on a preview card.
 *
 *  - `teamLookup: "checklist"` (settleCardTeamAnswer): the card is stamped
 *    `teamCheckOutcome: "checklist"` + `teamCheckDoneAt`, keeps no hint, and is
 *    NOT handed to the BSC lane (`bscTeamPool.enqueueBscTeamChecks`).
 *  - `checklistConflict`: an open "Checklist says otherwise" disagreement
 *    refuses the commit whole; nothing is written.
 *
 * Fixture conventions mirror `commitCardChecklist.teamAnswers.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Doc, Id } from "./_generated/dataModel";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(`this test file must not reach the network: ${String(url)}`);
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_checklistanswer_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_checklistanswer_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

async function seedTree(
  t: T,
): Promise<{ sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> }> {
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
      value: "Test Set",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

function card(opts: {
  cardNumber: string;
  bscRef?: string;
  teamLookup?: "answered" | "failed" | "checklist";
  checklistConflict?: {
    players?: { marketplace: string[]; checklist: string[] };
    teams?: { marketplace: string[]; checklist: string[] };
  };
}) {
  return {
    cardNumber: opts.cardNumber,
    cardName: `Card ${opts.cardNumber}`,
    teams: [],
    players: [],
    platformData: opts.bscRef !== undefined ? { bsc: { ref: opts.bscRef } } : {},
    ...(opts.teamLookup ? { teamLookup: opts.teamLookup } : {}),
    ...(opts.checklistConflict ? { checklistConflict: opts.checklistConflict } : {}),
  };
}

async function allRows(t: T, leafId: Id<"selectorOptions">): Promise<Doc<"cardChecklist">[]> {
  return t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
      .collect(),
  );
}

/** Every card id handed to the background BSC lane, read off the scheduler. */
async function enqueuedIds(t: T): Promise<Set<string>> {
  const rows = await t.run(async (ctx) =>
    (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => {
              collect: () => Promise<Array<{ name: string; args: unknown[] }>>;
            };
          };
        };
      }
    ).db.system.query("_scheduled_functions").collect(),
  );
  const ids = new Set<string>();
  for (const r of rows) {
    if (!r.name.includes("enqueueBscTeamChecks")) continue;
    const a = r.args[0] as { cardChecklistIds?: string[] } | undefined;
    for (const id of a?.cardChecklistIds ?? []) ids.add(id);
  }
  return ids;
}

async function settle(t: T): Promise<Set<string>> {
  const ids = await enqueuedIds(t);
  await drainScheduled(t);
  await cancelScheduled(t);
  return ids;
}

describe("commitCardChecklist: a card the publisher checklist answered", () => {
  test("is stamped checked with outcome \"checklist\", keeps no hint, and is never queued for BSC", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamLookup: "checklist" })],
    });

    const row = (await allRows(t, leafId))[0];
    expect(row.teamCheckDoneAt).toEqual(expect.any(Number));
    expect(row.teamCheckOutcome).toBe("checklist");
    expect(row.bscTeamName).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(false);
  });

  test("a card with no BSC ref is not stamped by the checklist answer (nothing was owed)", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", teamLookup: "checklist" })],
    });

    const row = (await allRows(t, leafId))[0];
    expect(row.teamCheckOutcome).toBeUndefined();
    expect(row.teamCheckDoneAt).toBeUndefined();
    await settle(t);
  });

  test("a card in the same commit that BSC did not answer is still queued", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teamLookup: "checklist" }),
        card({ cardNumber: "2", bscRef: "B2", teamLookup: "failed" }),
      ],
    });

    const rows = new Map((await allRows(t, leafId)).map((r) => [r.cardNumber, r]));
    const queued = await settle(t);
    expect(queued.has(rows.get("1")!._id)).toBe(false);
    expect(queued.has(rows.get("2")!._id)).toBe(true);
  });
});

describe("commitCardChecklist: an open checklistConflict", () => {
  const conflictOf = (what: "players" | "teams") => ({
    [what]: { marketplace: ["A"], checklist: ["B"] },
  });

  test.each(["players", "teams"] as const)(
    "refuses a card still carrying a %s disagreement, naming the card, and writes nothing",
    async (what) => {
      const t = convexTest(schema, modules);
      const { sportId, leafId } = await seedTree(t);

      await expect(
        t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
          selectorOptionId: leafId,
          sportId,
          cards: [
            card({ cardNumber: "1", bscRef: "B1" }),
            card({ cardNumber: "7", bscRef: "B7", checklistConflict: conflictOf(what) }),
          ],
        }),
      ).rejects.toThrow(/card #7 still carries an unsettled checklist disagreement/);

      expect(await allRows(t, leafId)).toEqual([]);
      await settle(t);
    },
  );

  test("commits the same card once the disagreement is stripped", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "7", bscRef: "B7" })],
    });

    expect((await allRows(t, leafId)).map((r) => r.cardNumber)).toEqual(["7"]);
    await settle(t);
  });
});
