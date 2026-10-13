/**
 * NEO-333 — `fetchCardChecklist` hands the client a TEAM FENCE.
 *
 * The team lookup is the fetch's last step: `resolveCandidateTeams` patches
 * BSC's team names onto the candidate rows, chunk by chunk, and then the
 * action returns. Convex resolves an action's promise on the client without
 * waiting for the subscriptions to catch up, and the row COUNT the client used
 * to wait on matched ~70s earlier — so the client could snapshot the rows
 * before their teams arrived, and the review wizard and the commit never saw
 * BSC's teams.
 *
 * The fix is a fence the client waits on: the batch id this run wrote, and
 * the batch's `ready` count as the last team write committed it. These tests
 * pin the server half of that contract:
 *
 *  - the fence names the batch `getReadyCandidates` shows, and its `ready`
 *    equals the subscription's `ready` once every team write has landed;
 *  - it is the count the server SAW, never a target. A row's status is per
 *    row (NEO-330 / NEO-341, `teamPending` in `startCandidateBatch`, decided
 *    by `initialCandidateStatus`): a card that arrived with its team already
 *    parsed is never looked up and is written `ready`, so once the lookups
 *    have landed `ready` reaches `total`. The client gates on both the fence
 *    and `ready === total`; per-row status is what keeps the second from
 *    hanging the one-marketplace path — the reason NEO-255 refused to gate on
 *    readiness at all;
 *  - a run with no lookup to do reports 0, and the count is the whole fence;
 *  - a lookup that THROWS is answered "no team" (NEO-330): the run still
 *    succeeds and the fence still advances, so the client's wait ends;
 *  - a FAILED run reports no fence (the client discards its batch anyway).
 *
 * Adapter mocking follows `fetchCardChecklist.attachedSides.test.ts`: both
 * marketplaces are module-mocked, so nothing here reaches a live marketplace.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

type Card = {
  cardNumber: string;
  cardName: string;
  teams?: string[];
  platformRef?: string;
  sourceBscSetSlug?: string;
};

const mockState = vi.hoisted(() => ({
  bscCards: [] as Card[],
  /** What BSC's per-card lookup answers, by card ref. */
  teamsByRef: {} as Record<string, { rawTeamName: string; teamNames: string[] }>,
  /** Every ref the lookup was asked about, so a test can see who was skipped. */
  lookedUp: [] as string[],
  /** When set, BSC's per-card team lookup throws — after the batch is written. */
  lookupThrows: false,
  /**
   * When set, writing the lookup's answers onto the candidate rows throws —
   * after the batch is written — and the run fails.
   */
  resolveThrows: false,
}));

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action, internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        facetFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        sourceFacet: v.optional(
          v.union(v.literal("setName"), v.literal("variantName")),
        ),
      },
      returns: v.object({
        success: v.boolean(),
        cards: v.array(v.any()),
        message: v.optional(v.string()),
        collisions: v.optional(v.array(v.any())),
      }),
      handler: async () => ({ success: true, cards: mockState.bscCards }),
    }),
    fetchBscCardTeamNames: internalAction({
      args: { bscCardIds: v.array(v.string()) },
      // NEO-335 shape: one entry per requested id with the lookup's own
      // success flag. A ref absent from `teamsByRef` ANSWERED with no team.
      returns: v.array(
        v.object({
          bscCardId: v.string(),
          rawTeamName: v.string(),
          teamNames: v.array(v.string()),
          success: v.boolean(),
        }),
      ),
      handler: async (_ctx, args) => {
        if (mockState.lookupThrows) throw new Error("BuySportsCards is down");
        mockState.lookedUp.push(...args.bscCardIds);
        return args.bscCardIds.map((bscCardId) => ({
          bscCardId,
          rawTeamName: mockState.teamsByRef[bscCardId]?.rawTeamName ?? "",
          teamNames: mockState.teamsByRef[bscCardId]?.teamNames ?? [],
          success: true,
        }));
      },
    }),
  };
});

// NEO-330 answers a THROWN lookup "no team", so the failed-run case fails the
// write that follows the lookup instead — still after the batch exists.
vi.mock("./checklistCandidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./checklistCandidates")>();
  const { internalMutation } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    resolveCandidateTeams: internalMutation({
      args: { batchId: v.string(), resolved: v.array(v.any()), retry: v.optional(v.boolean()) },
      returns: v.any(),
      handler: async (ctx, args) => {
        if (mockState.resolveThrows) throw new Error("write failed");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual.resolveCandidateTeams as any)._handler(ctx, args);
      },
    }),
  };
});

vi.mock("./adapters/sportlots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/sportlots")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchSportLotsChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.string())),
      },
      returns: v.object({
        success: v.boolean(),
        cards: v.array(v.any()),
        message: v.optional(v.string()),
      }),
      handler: async () => ({ success: true, cards: [] }),
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_333",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_333",
  name: "Admin",
  role: "admin",
};

/** A sport → year → setName → variantType chain linked to BSC only. */
async function seedBscOnlySet(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2022",
      platformData: { bsc: { b0: "2022" }, sportlots: { s0: "2022" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: { bsc: { b0: "topps" } },
      platformSlotSeq: { bsc: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    return await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: { bsc: { b0: "base" } },
      platformFacets: { bsc: { b0: "variant" } },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

function bscCard(n: string, teams?: string[]): Card {
  return {
    cardNumber: n,
    cardName: `BSC Card ${n}`,
    platformRef: `bsc-${n}`,
    sourceBscSetSlug: "topps",
    ...(teams ? { teams } : {}),
  };
}

beforeEach(() => {
  mockState.bscCards = [];
  mockState.teamsByRef = {};
  mockState.lookedUp = [];
  mockState.lookupThrows = false;
  mockState.resolveThrows = false;
});

describe("fetchCardChecklist — the team fence (NEO-333)", () => {
  test("names this run's batch, and its ready count is the subscription's once the teams have landed", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedBscOnlySet(t);
    mockState.bscCards = [
      // Looked up: BSC answers a dual-team value.
      bscCard("1"),
      // Looked up: BSC has no team for it. Still an answer — the row is ready.
      bscCard("2"),
      // Arrived with its team parsed: never looked up, so its row is written
      // `ready` from the start (NEO-330 / NEO-341).
      bscCard("3", ["San Diego Padres"]),
    ];
    mockState.teamsByRef = {
      "bsc-1": {
        rawTeamName: "Cleveland Guardians, Washington Nationals",
        teamNames: ["Cleveland Guardians", "Washington Nationals"],
      },
    };

    const admin = t.withIdentity(ADMIN);
    const result = await admin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: rowId,
    });
    expect(result.success).toBe(true);
    expect(result.candidateCount).toBe(3);
    expect(mockState.lookedUp.sort()).toEqual(["bsc-1", "bsc-2"]);

    const live = await admin.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: rowId,
    });
    // The fence names the batch the subscription shows…
    expect(result.candidateBatchId).toBeDefined();
    expect(live.batchId).toBe(result.candidateBatchId);
    // …and its ready count is the subscription's at (or after) the last team
    // write. A client waiting for `ready >= readyAfterTeams` on this batch is
    // therefore holding the teams below.
    expect(result.readyAfterTeams).toBe(3);
    expect(live.ready).toBe(3);
    const byNumber = new Map(live.cards.map((c) => [c.cardNumber, c]));
    expect(byNumber.get("1")?.teams).toEqual([
      "Cleveland Guardians",
      "Washington Nationals",
    ]);
    expect(byNumber.get("3")?.teams).toEqual(["San Diego Padres"]);

    // The fence is what the server SAW, never a target it might not reach.
    // Every row is ready, the pre-parsed one included, so the client's
    // `ready === total` half of the gate is met too — no row that never
    // needed a lookup can hold it (the hang NEO-255 refused to risk).
    expect(live.total).toBe(3);
    expect(live.ready).toBe(live.total);
    expect(byNumber.get("3")?.teamResolved).toBe(true);
  });

  test("a run with nothing to look up reports 0, and every row is already ready with its team", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedBscOnlySet(t);
    mockState.bscCards = [
      bscCard("1", ["San Diego Padres"]),
      bscCard("2", ["Seattle Mariners"]),
    ];

    const admin = t.withIdentity(ADMIN);
    const result = await admin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: rowId,
    });
    expect(mockState.lookedUp).toEqual([]);
    expect(result.readyAfterTeams).toBe(0);

    const live = await admin.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: rowId,
    });
    expect(live.batchId).toBe(result.candidateBatchId);
    expect(live.ready).toBe(live.total);
    expect(live.cards.every((c) => (c.teams?.length ?? 0) > 0)).toBe(true);
  });

  test("a lookup that throws is answered no team, and the fence still advances (NEO-330)", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedBscOnlySet(t);
    // The throw lands AFTER `startCandidateBatch` wrote the rows. Jason,
    // 2026-10-11: a lookup that never returns means the operator picks — the
    // fetch neither fails nor guesses.
    mockState.bscCards = [bscCard("1")];
    mockState.lookupThrows = true;

    const admin = t.withIdentity(ADMIN);
    const result = await admin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId: rowId,
    });
    expect(result.success).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.readyAfterTeams).toBe(1);
    const live = await admin.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: rowId,
    });
    expect(live.batchId).toBe(result.candidateBatchId);
    expect(live.ready).toBe(1);
    expect(live.cards[0].teams).toBeUndefined();
  });

  test("a failed run carries no fence", async () => {
    const t = convexTest(schema, modules);
    const rowId = await seedBscOnlySet(t);
    // The throw lands AFTER `startCandidateBatch` wrote the rows, so a batch
    // exists — and the failed run still names none of it.
    mockState.bscCards = [bscCard("1")];
    mockState.resolveThrows = true;

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });
    expect(result.success).toBe(false);
    expect(result.candidateCount).toBe(0);
    expect(result.candidateBatchId).toBeUndefined();
    expect(result.readyAfterTeams).toBeUndefined();
  });
});
