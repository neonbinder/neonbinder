/**
 * NEO-301 — the bulk review decide's WRITE half reads only the rows it writes.
 *
 * ## The failure this pins shut
 *
 * `recordAllRemainingAsCreate` / `recordAllRemainingAsSkip` were mutations
 * that opened a 200-row `by_selector_option_and_batch` range and then decided
 * at most 25 of the rows in it. OCC validates a mutation's whole read set, so
 * every Wikidata lookup `applyLookupResult` landed on ANY row of that window —
 * and every staged row it inserted at the batch tail, which the short last
 * page's open-ended range covers — invalidated the transaction. During a
 * lookup storm the mutation exhausted its retries (five times in one seed log)
 * and the wizard's armed auto-add turned itself off.
 *
 * They are actions now: `listBulkCandidates` (a query, outside OCC) chooses
 * the page and `decideRowsByIds` (a mutation) writes exactly those rows,
 * re-validating each live.
 *
 * ## Why this reads the read set through a Proxy
 *
 * The property is structural — "the mutation never opens a batch range" — and
 * a behavioural test cannot see it: convex-test runs transactions serially, so
 * there is no concurrent lookup to conflict with, and a mutation that still
 * read the window would pass every behavioural assertion here. So
 * `decideRowsByIdsImpl` runs inside `t.run` with `ctx.db` wrapped, and every
 * `query(table).withIndex(name, range)` and `get(id)` it performs — including
 * the ones inside `stageCareerTeamRowsImpl` and `isAmbiguousPlayerName` — is
 * recorded and asserted on. Bite-proofed: putting a batch `.take()` back into
 * the mutation turns the first test red.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { decideRowsByIdsImpl, ENTITY_REVIEW_BULK_PAGE } from "./entityReviewQueue";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const CALLER = "user_review_001";
const BATCH = "storm";

type IndexRead = {
  table: string;
  index: string | null;
  /** Fields the range pinned with `.eq`. */
  eqFields: string[];
  /** Whether the range used an inequality — i.e. it is a SCAN, not a point. */
  ranged: boolean;
};

/**
 * `ctx` with `ctx.db` wrapped so every indexed read and every `get` is
 * recorded. A query that never calls `withIndex` is recorded with a null
 * index, so a full-table scan cannot slip past as "no index read".
 */
function recordingCtx(ctx: MutationCtx): {
  ctx: MutationCtx;
  reads: IndexRead[];
  gets: string[];
} {
  const reads: IndexRead[] = [];
  const gets: string[] = [];
  const recordRange = (read: IndexRead) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          return (field: string) => {
            if (prop === "eq") read.eqFields.push(field);
            else read.ranged = true;
            return recordRange(read);
          };
        },
      },
    );
  const db = new Proxy(ctx.db, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return (id: string) => {
          gets.push(id);
          return target.get(id as never);
        };
      }
      if (prop === "query") {
        return (table: string) => {
          const read: IndexRead = { table, index: null, eqFields: [], ranged: false };
          reads.push(read);
          const builder = target.query(table as never);
          return new Proxy(builder, {
            get(b, p, r) {
              if (p === "withIndex") {
                return (
                  index: string,
                  range?: (q: unknown) => unknown,
                ) => {
                  read.index = index;
                  return b.withIndex(index as never, ((q: {
                    eq: (f: string, v: unknown) => unknown;
                  }) => {
                    // Record the field names by replaying the caller's range
                    // against a recorder, then hand the REAL builder the same
                    // range so the read itself is untouched.
                    if (range) range(recordRange(read));
                    return range ? range(q) : q;
                  }) as never);
                };
              }
              const value = Reflect.get(b, p, r);
              return typeof value === "function" ? value.bind(b) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ctx: { ...ctx, db } as MutationCtx, reads, gets };
}

async function seedSport(t: ReturnType<typeof convexTest>): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

type Seeded = {
  selectorOptionId: Id<"selectorOptions">;
  readyPlayers: Array<Id<"entityReviewQueue">>;
  enrichedPlayer: Id<"entityReviewQueue">;
  stintPlayer: Id<"entityReviewQueue">;
  pendingPlayers: Array<Id<"entityReviewQueue">>;
  ambiguousPlayer: Id<"entityReviewQueue">;
  decidedPlayer: Id<"entityReviewQueue">;
  teamRows: Array<Id<"entityReviewQueue">>;
  leagueRow: Id<"entityReviewQueue">;
  all: Array<Id<"entityReviewQueue">>;
};

/**
 * One batch holding every shape the walk treats differently: plain settled
 * players, one whose lookup brought a career team (so the write STAGES a row),
 * one with a hand-typed stint on a staged step (NEO-248), two still pending,
 * one whose name two NB players already carry, one already decided, checklist
 * and staged team rows, and a league row.
 */
async function seedStormBatch(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  const sportId = await seedSport(t);
  return t.run(async (ctx) => {
    const base = {
      selectorOptionId: sportId,
      batchId: BATCH,
      createdByUserId: CALLER,
      sportId,
    };
    const all: Array<Id<"entityReviewQueue">> = [];
    const add = async (
      fields: Omit<WithoutSystemFields<Doc<"entityReviewQueue">>, keyof typeof base>,
    ) => {
      const id = await ctx.db.insert("entityReviewQueue", { ...base, ...fields });
      all.push(id);
      return id;
    };
    const readyPlayers = [
      await add({ kind: "player", name: "Rookie One", status: "ready" }),
      await add({ kind: "player", name: "Rookie Two", status: "ready" }),
    ];
    const pendingPlayers = [
      await add({ kind: "player", name: "Still Looking", status: "pending" }),
      await add({ kind: "player", name: "Also Looking", status: "pending" }),
    ];
    const enrichedPlayer = await add({
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
      enrichment: { careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }] },
    });
    const teamRows = [await add({ kind: "team", name: "Padres", status: "ready" })];
    const stintPlayer = await add({ kind: "player", name: "Hand Typed", status: "ready" });
    teamRows.push(
      await add({
        kind: "team",
        name: "Oregon State Beavers",
        nameNormalized: "oregon state beavers",
        status: "ready",
        source: {
          kind: "careerTeamOf",
          playerRowId: stintPlayer,
          manualStint: { fromYear: 2021, toYear: 2023 },
        },
      }),
    );
    const ambiguousPlayer = await add({ kind: "player", name: "Bob Allen", status: "ready" });
    for (let i = 0; i < 2; i++) {
      await ctx.db.insert("players", {
        sportId,
        name: "Bob Allen",
        nameNormalized: normalizePlayerName("Bob Allen"),
        lastUpdated: Date.now(),
      });
    }
    const decidedPlayer = await add({
      kind: "player",
      name: "Already Answered",
      status: "ready",
      decision: { action: "skip" },
    });
    const leagueRow = await add({ kind: "league", name: "Australian Baseball League", status: "ready" });
    return {
      selectorOptionId: sportId,
      readyPlayers,
      enrichedPlayer,
      stintPlayer,
      pendingPlayers,
      ambiguousPlayer,
      decidedPlayer,
      teamRows,
      leagueRow,
      all,
    };
  });
}

async function candidates(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  action: "create" | "skip",
) {
  return t.query(internal.entityReviewQueue.listBulkCandidates, {
    selectorOptionId,
    batchId: BATCH,
    action,
    callerId: CALLER,
  });
}

describe("decideRowsByIds — the read set is the rows it writes (NEO-301)", () => {
  test("create: no batch range, and no get of a pending, team, league, ambiguous or decided row", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStormBatch(t);

    const page = await candidates(t, s.selectorOptionId, "create");
    // The query chose exactly the settled, unambiguous, undecided players.
    expect(new Set(page.ids)).toEqual(
      new Set([...s.readyPlayers, s.enrichedPlayer, s.stintPlayer]),
    );

    const { decided, reads, gets } = await t.run(async (ctx) => {
      const rec = recordingCtx(ctx);
      const decided = await decideRowsByIdsImpl(rec.ctx, {
        ids: page.ids,
        selectorOptionId: s.selectorOptionId,
        batchId: BATCH,
        action: "create",
        callerId: CALLER,
      });
      return { decided, reads: rec.reads, gets: rec.gets };
    });
    expect(decided).toBe(page.ids.length);

    // The recorder is live: the staging and stint reads it must see, it saw.
    expect(reads.some((r) => r.index === "by_source_player")).toBe(true);
    expect(reads.some((r) => r.index === "by_batch_and_kind_and_name")).toBe(true);
    // THE pin: nothing inside the write opens the batch window.
    expect(reads.filter((r) => r.index === "by_selector_option_and_batch")).toEqual([]);
    // No full-table scans either.
    expect(reads.filter((r) => r.index === null)).toEqual([]);
    // Every review-table read is either this player's own staged rows or a
    // by-NAME point lookup — never a range over the batch.
    for (const r of reads.filter((read) => read.table === "entityReviewQueue")) {
      expect(["by_source_player", "by_batch_and_kind_and_name"]).toContain(r.index);
      expect(r.ranged).toBe(false);
      if (r.index === "by_batch_and_kind_and_name") {
        expect(r.eqFields).toContain("nameNormalized");
      }
    }
    // The only review rows fetched are the candidates themselves.
    const seeded = new Set<string>(s.all);
    const reviewGets = gets.filter((id) => seeded.has(id));
    expect(new Set(reviewGets)).toEqual(new Set(page.ids));
    for (const forbidden of [
      ...s.pendingPlayers,
      ...s.teamRows,
      s.leagueRow,
      s.ambiguousPlayer,
      s.decidedPlayer,
    ]) {
      expect(gets).not.toContain(forbidden);
    }
  });

  test("skip: no batch range, and the only review rows fetched are the page it decides", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStormBatch(t);

    const page = await candidates(t, s.selectorOptionId, "skip");
    // Skip takes every undecided row — pending, teams and leagues included.
    expect(new Set(page.ids)).toEqual(
      new Set(s.all.filter((id) => id !== s.decidedPlayer)),
    );

    const { reads, gets } = await t.run(async (ctx) => {
      const rec = recordingCtx(ctx);
      await decideRowsByIdsImpl(rec.ctx, {
        ids: page.ids,
        selectorOptionId: s.selectorOptionId,
        batchId: BATCH,
        action: "skip",
        callerId: CALLER,
      });
      return { reads: rec.reads, gets: rec.gets };
    });

    // A skip reads nothing but its own rows: no index read at all.
    expect(reads).toEqual([]);
    expect(new Set(gets)).toEqual(new Set(page.ids));
    expect(gets).not.toContain(s.decidedPlayer);
  });
});

describe("decideRowsByIds — a stale candidate is skipped, not written (NEO-301)", () => {
  test("a row that turned pending, got decided, was deleted or became ambiguous is left alone", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStormBatch(t);
    const page = await candidates(t, s.selectorOptionId, "create");
    const [turnedPending, decidedByHand] = s.readyPlayers;

    // Between the query and the mutation: the operator un-decides a row back
    // into a lookup, decides another one by hand, a colleague's commit makes a
    // third name ambiguous, and one row is deleted outright.
    await t.run(async (ctx) => {
      await ctx.db.patch(turnedPending, { status: "pending" });
      await ctx.db.patch(decidedByHand, {
        decision: { action: "skip" },
        lastTouchedAt: 1234,
      });
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("players", {
          sportId: s.selectorOptionId,
          name: "Hand Typed",
          nameNormalized: normalizePlayerName("Hand Typed"),
          lastUpdated: Date.now(),
        });
      }
      await ctx.db.delete(s.enrichedPlayer);
    });

    const decided = await t.mutation(internal.entityReviewQueue.decideRowsByIds, {
      ids: page.ids,
      selectorOptionId: s.selectorOptionId,
      batchId: BATCH,
      action: "create",
      callerId: CALLER,
    });

    // Every candidate went stale, so nothing was decided — and nothing threw.
    expect(decided).toBe(0);
    const after = await t.run(async (ctx) => ({
      turnedPending: await ctx.db.get(turnedPending),
      decidedByHand: await ctx.db.get(decidedByHand),
      stintPlayer: await ctx.db.get(s.stintPlayer),
    }));
    expect(after.turnedPending!.decision).toBeUndefined();
    expect(after.decidedByHand!.decision).toEqual({ action: "skip" });
    expect(after.decidedByHand!.lastTouchedAt).toBe(1234);
    expect(after.stintPlayer!.decision).toBeUndefined();
  });

  test("the create decision still carries a hand-typed stint and stages career teams", async () => {
    // Behaviour the split must not lose: NEO-248's stint on the decision and
    // NEO-236's staging of the enriched player's career team.
    const t = convexTest(schema, modules);
    const s = await seedStormBatch(t);
    const page = await candidates(t, s.selectorOptionId, "create");

    await t.mutation(internal.entityReviewQueue.decideRowsByIds, {
      ids: page.ids,
      selectorOptionId: s.selectorOptionId,
      batchId: BATCH,
      action: "create",
      callerId: CALLER,
    });

    const rows = await t.run(async (ctx) => ctx.db.query("entityReviewQueue").collect());
    const stint = rows.find((r) => r._id === s.stintPlayer)!;
    expect(stint.decision).toEqual({
      action: "create",
      manualCareerTeams: [{ name: "Oregon State Beavers", fromYear: 2021, toYear: 2023 }],
    });
    const staged = rows.filter(
      (r) => r.source?.kind === "careerTeamOf" && r.source.playerRowId === s.enrichedPlayer,
    );
    expect(staged.map((r) => r.name)).toEqual(["Sydney Blue Sox"]);
    expect(staged[0].decision).toBeUndefined();
  });

  test("a row of another session refuses the whole page before any write", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStormBatch(t);
    const page = await candidates(t, s.selectorOptionId, "skip");
    await t.run(async (ctx) => {
      await ctx.db.patch(page.ids[page.ids.length - 1], { createdByUserId: "someone_else" });
    });

    await expect(
      t.mutation(internal.entityReviewQueue.decideRowsByIds, {
        ids: page.ids,
        selectorOptionId: s.selectorOptionId,
        batchId: BATCH,
        action: "skip",
        callerId: CALLER,
      }),
    ).rejects.toThrow(/different review session/);
    const decidedNow = await t.run(async (ctx) =>
      (await ctx.db.query("entityReviewQueue").collect()).filter(
        (r) => r._id !== s.decidedPlayer && r.decision,
      ),
    );
    expect(decidedNow).toEqual([]);
  });

  test("a row of another batch is skipped, and an oversized page is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await seedStormBatch(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.readyPlayers[0], { batchId: "some-other-batch" });
    });

    const decided = await t.mutation(internal.entityReviewQueue.decideRowsByIds, {
      ids: [s.readyPlayers[0]],
      selectorOptionId: s.selectorOptionId,
      batchId: BATCH,
      action: "create",
      callerId: CALLER,
    });
    expect(decided).toBe(0);

    // Duplicates collapse first, so an oversized list has to be genuinely
    // oversized; seed enough distinct rows to make one.
    const extra = await t.run(async (ctx) => {
      const ids: Array<Id<"entityReviewQueue">> = [];
      for (let i = 0; i <= ENTITY_REVIEW_BULK_PAGE.create.decide; i++) {
        ids.push(
          await ctx.db.insert("entityReviewQueue", {
            selectorOptionId: s.selectorOptionId,
            batchId: BATCH,
            createdByUserId: CALLER,
            kind: "player",
            name: `Filler ${i}`,
            sportId: s.selectorOptionId,
            status: "ready",
          }),
        );
      }
      return ids;
    });
    await expect(
      t.mutation(internal.entityReviewQueue.decideRowsByIds, {
        ids: extra,
        selectorOptionId: s.selectorOptionId,
        batchId: BATCH,
        action: "create",
        callerId: CALLER,
      }),
    ).rejects.toThrow(/Too many review rows/);
  });
});
