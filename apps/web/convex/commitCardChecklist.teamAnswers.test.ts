/**
 * NEO-335 — a card's team, answered before save, written at commit.
 *
 * Three answers reach `commitCardChecklist` on a preview card:
 *
 *  - `teamLookup` — how the fetch-time BSC team lookup ended. "answered" means
 *    BSC replied (with a team, or none on file) and the card is stamped
 *    `teamCheckDoneAt` at save instead of being queued to ask BSC again;
 *    "failed" or ABSENT keeps the old behaviour (queued).
 *  - `teamIds` — NB teams the operator picked. Validated server-side: another
 *    sport's team refuses the commit, a deleted one is dropped.
 *  - `teamNone` — "No team on this card". Stamped like `confirmCardNoTeam`.
 *    Teams win.
 *
 * Fixture conventions mirror `commitCardChecklist.operatorDecisions.test.ts`.
 * Which cards were queued is read off the scheduler's own rows (the
 * `processBscTeamEnrichmentQueue` invocation the finalize phase schedules),
 * and the queue itself is never run: fetch throws, and pending work is
 * cancelled before the test ends.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { MAX_CARD_TEAMS } from "./features/cardAttention";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";

beforeEach(() => {
  // Nothing here may reach BSC. A throwing stub, the suite's convention: the
  // adapter swallows a request failure, so a stray queue run writes nothing.
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(`NEO-335: this test file must not reach the network: ${String(url)}`);
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
  subject: "admin_teamanswers_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_teamanswers_001",
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

async function seedSport(t: T, value: string): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      sportConfig: { skuCode: value.slice(0, 2).toUpperCase(), league: value },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function seedTeam(
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

/** One preview card as the commit wire carries it, NEO-335 fields included. */
function card(opts: {
  cardNumber: string;
  bscRef?: string;
  slRef?: string;
  teams?: string[];
  teamLookup?: "answered" | "failed";
  teamIds?: Array<Id<"teams">>;
  teamNone?: true;
  applyFields?: string[];
  baseVersion?: number;
}) {
  const platformData: { bsc?: { ref: string }; sportlots?: { ref: string } } = {};
  if (opts.bscRef !== undefined) platformData.bsc = { ref: opts.bscRef };
  if (opts.slRef !== undefined) platformData.sportlots = { ref: opts.slRef };
  return {
    cardNumber: opts.cardNumber,
    cardName: `Card ${opts.cardNumber}`,
    teams: opts.teams ?? [],
    players: [],
    platformData,
    ...(opts.teamLookup ? { teamLookup: opts.teamLookup } : {}),
    ...(opts.teamIds ? { teamIds: opts.teamIds } : {}),
    ...(opts.teamNone ? { teamNone: opts.teamNone } : {}),
    ...(opts.applyFields ? { applyFields: opts.applyFields } : {}),
    ...(opts.baseVersion !== undefined ? { baseVersion: opts.baseVersion } : {}),
  };
}

async function rowsByNumber(
  t: T,
  leafId: Id<"selectorOptions">,
): Promise<Map<string, Doc<"cardChecklist">>> {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
      .collect(),
  );
  return new Map(rows.map((r) => [r.cardNumber, r]));
}

/** Every card id the commit handed to the background BSC team lookup. */
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
    if (!r.name.includes("processBscTeamEnrichmentQueue")) continue;
    const a = r.args[0] as { cardChecklistIds?: string[] } | undefined;
    for (const id of a?.cardChecklistIds ?? []) ids.add(id);
  }
  return ids;
}

/** Read the queue, then make sure nothing is left to fire during teardown. */
async function settle(t: T): Promise<Set<string>> {
  const ids = await enqueuedIds(t);
  await drainScheduled(t);
  await cancelScheduled(t);
  return ids;
}

/** A team-review batch row the operator answered "not a team" for. */
async function skipTeamName(
  t: T,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    sportId: Id<"selectorOptions">;
    batchId: string;
    name: string;
  },
) {
  await t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      createdByUserId: ADMIN_IDENTITY.subject,
      kind: "team",
      name: opts.name,
      sportId: opts.sportId,
      status: "ready",
      decision: { action: "skip" },
    }),
  );
}

describe("commitCardChecklist — the fetch-time BSC lookup's answer (NEO-335)", () => {
  test("an ANSWERED blank card is stamped checked at save and never queued", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamLookup: "answered" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamCheckDoneAt).toEqual(expect.any(Number));
    // BSC had nothing on file: no hint to keep.
    expect(row.bscTeamName).toBeUndefined();
    expect(row.teamOnCardIds).toBeUndefined();
    expect(row.teamNoneConfirmedAt).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(false);
  });

  test("a FAILED lookup is queued for the background retry, unstamped", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamLookup: "failed" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamCheckDoneAt).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(true);
  });

  test("an older client (no teamLookup) keeps the old behaviour: queued", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamCheckDoneAt).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(true);
  });

  test("ANSWERED but unmatched (operator skipped BSC's string): stamped, BSC's string kept as the hint", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await skipTeamName(t, {
      selectorOptionId: leafId,
      sportId,
      batchId: "batch-1",
      name: "Gotham Knights",
    });

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      batchId: "batch-1",
      cards: [
        card({
          cardNumber: "1",
          bscRef: "B1",
          teams: ["Gotham Knights"],
          teamLookup: "answered",
        }),
      ],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamCheckDoneAt).toEqual(expect.any(Number));
    expect(row.bscTeamName).toBe("Gotham Knights");
    expect(row.teamOnCardIds).toBeUndefined();
    expect(row.pendingTeamNames).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(false);
  });

  test("ANSWERED with the name still pending review: stamped, no hint (the pending name carries it), not queued", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    // No review row for the name and no team row: it reaches commit
    // unreviewed, so it is stamped as a pending name.
    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Gotham Knights"], teamLookup: "answered" }),
      ],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.pendingTeamNames).toEqual(["Gotham Knights"]);
    expect(row.teamCheckDoneAt).toEqual(expect.any(Number));
    expect(row.bscTeamName).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(false);
  });

  test("ANSWERED with a team that resolves: linked, nothing extra stamped, not queued", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Cincinnati Reds"], teamLookup: "answered" }),
      ],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toEqual([reds]);
    expect(row.teamCheckDoneAt).toBeUndefined();
    expect(row.bscTeamName).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(false);
  });

  test("a card with no BSC ref is never stamped by a teamLookup it should not carry", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", slRef: "S1", teamLookup: "answered" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamCheckDoneAt).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(false);
  });
});

describe("commitCardChecklist — operator-chosen teamIds (NEO-335)", () => {
  test("a same-sport team is written, unioned with the names that resolved, deduped", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");
    const royals = await seedTeam(t, sportId, "Kansas City Royals");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "1",
          bscRef: "B1",
          teams: ["Cincinnati Reds"],
          teamIds: [royals, reds, royals],
          teamLookup: "answered",
        }),
        card({ cardNumber: "2", bscRef: "B2", teamIds: [royals], teamLookup: "failed" }),
      ],
    });

    const rows = await rowsByNumber(t, leafId);
    // Printed name first, then the operator's pick; each id once.
    expect(rows.get("1")!.teamOnCardIds).toEqual([reds, royals]);
    expect(rows.get("2")!.teamOnCardIds).toEqual([royals]);
    // The listing title names the picked team like any other.
    expect(rows.get("2")!.listingTitle).toContain("Kansas City Royals");
    const queued = await settle(t);
    // A card with a team is never queued, whatever its lookup said.
    expect(queued.has(rows.get("2")!._id)).toBe(false);
  });

  test("another sport's team REFUSES the commit before anything is written", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const football = await seedSport(t, "Football");
    const bengals = await seedTeam(t, football, "Cincinnati Bengals");

    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [bengals] })],
      }),
    ).rejects.toThrow(/another sport/);

    expect((await rowsByNumber(t, leafId)).size).toBe(0);
    await settle(t);
  });

  test("the sport is walked from the row, not taken from the client's sportId argument", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const football = await seedSport(t, "Football");
    const bengals = await seedTeam(t, football, "Cincinnati Bengals");

    // The client claims the football sport; the row is baseball.
    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId: football,
        cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [bengals] })],
      }),
    ).rejects.toThrow(/another sport/);
    await settle(t);
  });

  test("a team deleted since it was picked is DROPPED; the save goes through", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const gone = await seedTeam(t, sportId, "Montreal Expos");
    await t.run(async (ctx) => ctx.db.delete(gone));

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [gone], teamLookup: "answered" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toBeUndefined();
    // Still an answered teamless card: stamped, surfaced by the walker.
    expect(row.teamCheckDoneAt).toEqual(expect.any(Number));
    await settle(t);
  });

  test("more than the per-card cap of picked teams is refused", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const team = await seedTeam(t, sportId, "Cincinnati Reds");

    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({
            cardNumber: "1",
            bscRef: "B1",
            teamIds: Array.from({ length: MAX_CARD_TEAMS + 1 }, () => team),
          }),
        ],
      }),
    ).rejects.toThrow(/chosen teams, above the/);
    expect((await rowsByNumber(t, leafId)).size).toBe(0);
  });
});

describe("commitCardChecklist — \"No team on this card\" (NEO-335)", () => {
  test("stamps the confirmation as the committing admin, plus teamCheckDoneAt; never queued", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teamNone: true, teamLookup: "failed" }),
        // No marketplace ref at all: the answer means the same thing.
        card({ cardNumber: "2", slRef: "S2", teamNone: true }),
      ],
    });

    const rows = await rowsByNumber(t, leafId);
    for (const n of ["1", "2"]) {
      const row = rows.get(n)!;
      expect(row.teamNoneConfirmedAt).toEqual(expect.any(Number));
      expect(row.teamNoneConfirmedByUserId).toBe(ADMIN_IDENTITY.subject);
      expect(row.teamCheckDoneAt).toEqual(expect.any(Number));
      expect(row.teamOnCardIds).toBeUndefined();
    }
    // A human settled it; a failed lookup is not retried over that.
    expect((await settle(t)).has(rows.get("1")!._id)).toBe(false);
  });

  test("teams WIN: picked teamIds ignore teamNone", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [reds], teamNone: true })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toEqual([reds]);
    expect(row.teamNoneConfirmedAt).toBeUndefined();
    expect(row.teamNoneConfirmedByUserId).toBeUndefined();
    await settle(t);
  });

  test("teams WIN: a team NAME that resolves ignores teamNone", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Cincinnati Reds"], teamNone: true }),
      ],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toEqual([reds]);
    expect(row.teamNoneConfirmedAt).toBeUndefined();
    await settle(t);
  });

  test("teams WIN: a name still pending review ignores teamNone", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Gotham Knights"], teamNone: true }),
      ],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.pendingTeamNames).toEqual(["Gotham Knights"]);
    expect(row.teamNoneConfirmedAt).toBeUndefined();
    await settle(t);
  });

  test("a skipped team name is no team: teamNone applies", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await skipTeamName(t, { selectorOptionId: leafId, sportId, batchId: "batch-1", name: "Checklist" });

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      batchId: "batch-1",
      cards: [card({ cardNumber: "1", bscRef: "B1", teams: ["Checklist"], teamNone: true })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamNoneConfirmedAt).toEqual(expect.any(Number));
    expect(row.teamOnCardIds).toBeUndefined();
    await settle(t);
  });
});

describe("commitCardChecklist — re-sync of existing rows, same rule (NEO-335)", () => {
  /** First sync as an older client would send it: queued, unstamped. */
  async function firstSync(t: T) {
    const { sportId, leafId } = await seedTree(t);
    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1" })],
    });
    await settle(t);
    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamCheckDoneAt).toBeUndefined();
    return { sportId, leafId, rowId: row._id };
  }

  test("an ANSWERED re-sync stamps the existing teamless row and does not queue it", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    const before = await enqueuedIds(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamLookup: "answered" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row._id).toBe(rowId);
    expect(row.teamCheckDoneAt).toEqual(expect.any(Number));
    const after = await settle(t);
    // Every queue entry that names this row predates the second sync.
    expect([...after].filter((id) => id === rowId).length).toBe(
      [...before].filter((id) => id === rowId).length,
    );
  });

  test("a FAILED re-sync still queues the existing teamless row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    const countQueues = async () =>
      t.run(async (ctx) => {
        const c = ctx as unknown as {
          db: {
            system: {
              query: (n: string) => {
                collect: () => Promise<Array<{ name: string; args: unknown[] }>>;
              };
            };
          };
        };
        const rows = await c.db.system.query("_scheduled_functions").collect();
        return rows.filter(
          (r) =>
            r.name.includes("processBscTeamEnrichmentQueue") &&
            ((r.args[0] as { cardChecklistIds?: string[] }).cardChecklistIds ?? []).includes(rowId),
        ).length;
      });
    const before = await countQueues();

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamLookup: "failed" })],
    });

    expect(await countQueues()).toBeGreaterThan(before);
    await settle(t);
  });

  test("an operator's existing \"no team\" ruling is never overwritten", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    await t.run(async (ctx) =>
      ctx.db.patch(rowId, { teamNoneConfirmedAt: 1234, teamNoneConfirmedByUserId: "someone_else" }),
    );

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamNone: true, teamLookup: "answered" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamNoneConfirmedAt).toBe(1234);
    expect(row.teamNoneConfirmedByUserId).toBe("someone_else");
    await settle(t);
  });

  test("picked teamIds FILL an existing row that has no team, and retire a stale \"no team\" ruling", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");
    await t.run(async (ctx) =>
      ctx.db.patch(rowId, { teamNoneConfirmedAt: 1234, teamNoneConfirmedByUserId: "someone_else" }),
    );

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [reds] })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toEqual([reds]);
    expect(row.teamNoneConfirmedAt).toBeUndefined();
    expect(row.teamNoneConfirmedByUserId).toBeUndefined();
    await settle(t);
  });

  test("picked teamIds never overwrite a team the existing row already has", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");
    const royals = await seedTeam(t, sportId, "Kansas City Royals");
    await t.run(async (ctx) => ctx.db.patch(rowId, { teamOnCardIds: [reds] }));

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [royals] })],
    });

    expect((await rowsByNumber(t, leafId)).get("1")!.teamOnCardIds).toEqual([reds]);
    await settle(t);
  });
});
