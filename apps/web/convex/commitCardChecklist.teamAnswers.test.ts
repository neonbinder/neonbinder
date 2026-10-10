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
  teamsAnswered?: true;
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
    ...(opts.teamsAnswered ? { teamsAnswered: opts.teamsAnswered } : {}),
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
    // The operator's picks first (in their order), then the printed names —
    // so the per-card cap can never cut a pick; each id once.
    expect(rows.get("1")!.teamOnCardIds).toEqual([royals, reds]);
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

  test("picked teamIds FILL an existing row that has no team", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await firstSync(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [reds] })],
    });

    expect((await rowsByNumber(t, leafId)).get("1")!.teamOnCardIds).toEqual([reds]);
    await settle(t);
  });

  test("picked teamIds never fill a row an operator ruled teamless: the ruling stands", async () => {
    // The ruling is an answer to this exact question, made on the row; a pick
    // in a later wizard was made without it on screen. Undoing it is the
    // fixer's job, where the ruling is what the operator is looking at.
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
    expect(row.teamOnCardIds ?? []).toEqual([]);
    expect(row.teamNoneConfirmedAt).toBe(1234);
    expect(row.teamNoneConfirmedByUserId).toBe("someone_else");
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

// ───────────────────────────────────────────────────────────────────────────
// Adversarial pass (NEO-335): the edges the happy-path blocks above leave open
// ───────────────────────────────────────────────────────────────────────────

describe("commitCardChecklist — adversarial edges of the team answer (NEO-335)", () => {
  /** Every row under the leaf, keyed by its BSC ref — never by card number. */
  async function rowsByBscRef(
    t: T,
    leafId: Id<"selectorOptions">,
  ): Promise<Map<string, Doc<"cardChecklist">>> {
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
        .collect(),
    );
    return new Map(rows.map((r) => [r.platformData?.bsc?.ref ?? r._id, r]));
  }

  test("teams WIN on insert: the node's set-level team fills a card the operator answered \"No team on this card\"", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");
    await t.run(async (ctx) => ctx.db.patch(leafId, { teamIds: [reds] }));

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamNone: true, teamLookup: "answered" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toEqual([reds]);
    // The answer was dropped, not stamped beside a team it contradicts.
    expect(row.teamNoneConfirmedAt).toBeUndefined();
    expect(row.teamNoneConfirmedByUserId).toBeUndefined();
    expect((await settle(t)).has(row._id)).toBe(false);
  });

  test("a pick whose team was deleted does not count as a team: \"No team on this card\" still applies", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const gone = await seedTeam(t, sportId, "Montreal Expos");
    await t.run(async (ctx) => ctx.db.delete(gone));

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [gone], teamNone: true })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toBeUndefined();
    expect(row.teamNoneConfirmedAt).toEqual(expect.any(Number));
    expect(row.teamNoneConfirmedByUserId).toBe(ADMIN_IDENTITY.subject);
    await settle(t);
  });

  test("two cards sharing a card number keep their OWN answers — the number is never the key", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "7", bscRef: "B7a", teamIds: [reds] }),
        card({ cardNumber: "7", bscRef: "B7b", teamNone: true }),
        card({ cardNumber: "7", bscRef: "B7c", teamLookup: "failed" }),
      ],
    });

    const rows = await rowsByBscRef(t, leafId);
    expect(rows.size).toBe(3);
    expect(rows.get("B7a")!.teamOnCardIds).toEqual([reds]);
    expect(rows.get("B7a")!.teamNoneConfirmedAt).toBeUndefined();
    expect(rows.get("B7b")!.teamOnCardIds).toBeUndefined();
    expect(rows.get("B7b")!.teamNoneConfirmedAt).toEqual(expect.any(Number));
    expect(rows.get("B7c")!.teamOnCardIds).toBeUndefined();
    expect(rows.get("B7c")!.teamNoneConfirmedAt).toBeUndefined();
    const queued = await settle(t);
    expect(queued.has(rows.get("B7a")!._id)).toBe(false);
    expect(queued.has(rows.get("B7b")!._id)).toBe(false);
    expect(queued.has(rows.get("B7c")!._id)).toBe(true);
  });

  test("a node with no sport to check against fails CLOSED: any picked team refuses the commit", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t, "Baseball");
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");
    // An orphan node: no sport ancestor, so no team can be verified for it.
    const orphanId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Orphan",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: orphanId,
        sportId,
        cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [reds] })],
      }),
    ).rejects.toThrow(/could not be checked/);
    expect((await rowsByNumber(t, orphanId)).size).toBe(0);
    await settle(t);
  });

  test("operator team ids are validated across pages: a foreign team past the first page still refuses the whole commit", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const football = await seedSport(t, "Football");
    // 500 same-sport teams fill page one exactly; the foreign team is the
    // 501st distinct id, so only the SECOND validation page can see it.
    const teamIds = await t.run(async (ctx) => {
      const ids: Array<Id<"teams">> = [];
      for (let i = 0; i < 500; i++) {
        ids.push(
          await ctx.db.insert("teams", {
            name: `Team ${i}`,
            nameNormalized: normalizeTeamName(`Team ${i}`),
            sportId,
            lastUpdated: Date.now(),
          }),
        );
      }
      return ids;
    });
    const bengals = await seedTeam(t, football, "Cincinnati Bengals");
    const all = [...teamIds, bengals];
    const cards = [];
    for (let i = 0; i < all.length; i += MAX_CARD_TEAMS) {
      cards.push(
        card({ cardNumber: String(i), bscRef: `B${i}`, teamIds: all.slice(i, i + MAX_CARD_TEAMS) }),
      );
    }

    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards,
      }),
    ).rejects.toThrow(/another sport/);
    expect((await rowsByNumber(t, leafId)).size).toBe(0);
    await settle(t);
  });

  test("a team validated on the SECOND page is written by name like one from the first", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const teamIds = await t.run(async (ctx) => {
      const ids: Array<Id<"teams">> = [];
      for (let i = 0; i < 501; i++) {
        ids.push(
          await ctx.db.insert("teams", {
            name: `Team ${i}`,
            nameNormalized: normalizeTeamName(`Team ${i}`),
            sportId,
            lastUpdated: Date.now(),
          }),
        );
      }
      return ids;
    });
    const cards = [];
    for (let i = 0; i < teamIds.length; i += MAX_CARD_TEAMS) {
      cards.push(
        card({ cardNumber: String(i), bscRef: `B${i}`, teamIds: teamIds.slice(i, i + MAX_CARD_TEAMS) }),
      );
    }

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards,
    });

    // The last card carries only the 501st id — the one page two validated.
    const last = (await rowsByBscRef(t, leafId)).get("B496")!;
    expect(last.teamOnCardIds).toEqual(teamIds.slice(496));
    expect(last.listingTitle).toContain("Team 500");
    await settle(t);
  });
});

describe("commitCardChecklist — adversarial edges on re-sync (NEO-335)", () => {
  /**
   * How many queue entries name this row. The first sync's own entry stays
   * in `_scheduled_functions` (cancelled), so a re-sync is judged by whether
   * it ADDED one, never by whether one exists.
   */
  async function queueEntriesFor(t: T, rowId: Id<"cardChecklist">): Promise<number> {
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
    return rows.filter(
      (r) =>
        r.name.includes("processBscTeamEnrichmentQueue") &&
        ((r.args[0] as { cardChecklistIds?: string[] }).cardChecklistIds ?? []).includes(rowId),
    ).length;
  }

  async function firstSync(t: T) {
    const { sportId, leafId } = await seedTree(t);
    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1" })],
    });
    await settle(t);
    const row = (await rowsByNumber(t, leafId)).get("1")!;
    return { sportId, leafId, rowId: row._id };
  }

  test("an existing row's teamCheckDoneAt is never re-stamped by \"No team on this card\"", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    await t.run(async (ctx) => ctx.db.patch(rowId, { teamCheckDoneAt: 1111 }));

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamNone: true })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamNoneConfirmedAt).toEqual(expect.any(Number));
    expect(row.teamNoneConfirmedByUserId).toBe(ADMIN_IDENTITY.subject);
    expect(row.teamCheckDoneAt).toBe(1111);
    await settle(t);
  });

  test("an ANSWERED re-sync leaves an existing teamCheckDoneAt and bscTeamName exactly as they were", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    await t.run(async (ctx) =>
      ctx.db.patch(rowId, { teamCheckDoneAt: 1111, bscTeamName: "Older Hint" }),
    );
    await skipTeamName(t, {
      selectorOptionId: leafId,
      sportId,
      batchId: "batch-2",
      name: "Gotham Knights",
    });
    const queuedBefore = await queueEntriesFor(t, rowId);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      batchId: "batch-2",
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Gotham Knights"], teamLookup: "answered" }),
      ],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamCheckDoneAt).toBe(1111);
    expect(row.bscTeamName).toBe("Older Hint");
    expect(await queueEntriesFor(t, rowId)).toBe(queuedBefore);
    await settle(t);
  });

  test("\"No team on this card\" never lands on an existing row that already has a team", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");
    await t.run(async (ctx) => ctx.db.patch(rowId, { teamOnCardIds: [reds] }));

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamNone: true, teamLookup: "answered" })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toEqual([reds]);
    expect(row.teamNoneConfirmedAt).toBeUndefined();
    // Nor does the lookup's answer stamp a row that has its team.
    expect(row.teamCheckDoneAt).toBeUndefined();
    await settle(t);
  });

  test("\"No team on this card\" is not stamped over an existing row's pending team name", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    await t.run(async (ctx) => ctx.db.patch(rowId, { pendingTeamNames: ["Gotham Knights"] }));

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamNone: true })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.pendingTeamNames).toEqual(["Gotham Knights"]);
    expect(row.teamNoneConfirmedAt).toBeUndefined();
    expect(row.teamNoneConfirmedByUserId).toBeUndefined();
    await settle(t);
  });

  test("picked teamIds fill an existing row while its pending team name stays for review", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");
    await t.run(async (ctx) => ctx.db.patch(rowId, { pendingTeamNames: ["Gotham Knights"] }));
    const queuedBefore = await queueEntriesFor(t, rowId);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teamIds: [reds] })],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toEqual([reds]);
    expect(await queueEntriesFor(t, rowId)).toBe(queuedBefore);
    await settle(t);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit fixes (NEO-335): answered team NAMES, and picks ahead of the cap
// ───────────────────────────────────────────────────────────────────────────

describe("commitCardChecklist — an answered team NAME fills an existing teamless row (NEO-335)", () => {
  async function firstSync(t: T) {
    const { sportId, leafId } = await seedTree(t);
    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1" })],
    });
    await settle(t);
    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds ?? []).toEqual([]);
    return { sportId, leafId, rowId: row._id };
  }

  test("a sibling's printed team, answered: the existing row takes it without applyFields", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await firstSync(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Cincinnati Reds"], teamsAnswered: true }),
      ],
    });

    expect((await rowsByNumber(t, leafId)).get("1")!.teamOnCardIds).toEqual([reds]);
    await settle(t);
  });

  test("the same string NOT answered is marketplace content: no applyFields, no write", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await firstSync(t);
    await seedTeam(t, sportId, "Cincinnati Reds");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", bscRef: "B1", teams: ["Cincinnati Reds"] })],
    });

    expect((await rowsByNumber(t, leafId)).get("1")!.teamOnCardIds ?? []).toEqual([]);
    await settle(t);
  });

  test("a team staged as New Team in this review is created by the prelude and fills the existing row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await firstSync(t);
    const batchId = "batch-staged-team";
    await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: leafId,
        batchId,
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "team",
        name: "Gotham Knights",
        sportId,
        status: "ready",
        decision: { action: "create", create: { location: "Gotham", name: "Knights" } },
      }),
    );

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      batchId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Gotham Knights"], teamsAnswered: true }),
      ],
    });

    const created = await t.run(async (ctx) =>
      ctx.db
        .query("teams")
        .withIndex("by_sport_id", (q) => q.eq("sportId", sportId))
        .collect(),
    );
    expect(created).toHaveLength(1);
    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds).toEqual([created[0]._id]);
    expect(row.pendingTeamNames ?? []).toEqual([]);
    await settle(t);
  });

  test("an answered name never overwrites a team the existing row already has", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    const reds = await seedTeam(t, sportId, "Cincinnati Reds");
    await seedTeam(t, sportId, "Kansas City Royals");
    await t.run(async (ctx) => ctx.db.patch(rowId, { teamOnCardIds: [reds] }));

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Kansas City Royals"], teamsAnswered: true }),
      ],
    });

    expect((await rowsByNumber(t, leafId)).get("1")!.teamOnCardIds).toEqual([reds]);
    await settle(t);
  });

  test("an answered name never fills a row an operator ruled teamless", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId, rowId } = await firstSync(t);
    await seedTeam(t, sportId, "Cincinnati Reds");
    await t.run(async (ctx) =>
      ctx.db.patch(rowId, { teamNoneConfirmedAt: 1234, teamNoneConfirmedByUserId: "someone_else" }),
    );

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", bscRef: "B1", teams: ["Cincinnati Reds"], teamsAnswered: true }),
      ],
    });

    const row = (await rowsByNumber(t, leafId)).get("1")!;
    expect(row.teamOnCardIds ?? []).toEqual([]);
    expect(row.teamNoneConfirmedAt).toBe(1234);
    await settle(t);
  });
});

describe("commitCardChecklist — a pick is never the one the per-card cap cuts (NEO-335)", () => {
  test("a full card of printed teams plus one pick keeps the pick", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const printed: string[] = [];
    for (let i = 0; i < MAX_CARD_TEAMS; i++) {
      const name = `Printed Team ${i}`;
      await seedTeam(t, sportId, name);
      printed.push(name);
    }
    const pick = await seedTeam(t, sportId, "Picked Team");

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", teams: printed, teamIds: [pick] })],
    });

    const ids = (await rowsByNumber(t, leafId)).get("1")!.teamOnCardIds ?? [];
    expect(ids).toHaveLength(MAX_CARD_TEAMS);
    expect(ids[0]).toBe(pick);
    await settle(t);
  });
});
