/**
 * NEO-195 — the readiness gate.
 *
 * The gate is the whole feature, not an optimisation: a card that appears
 * before its team resolves still LOOKS reviewable, so an operator either waits
 * anyway or approves something incomplete. These tests pin what may be shown.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
// NEO-294 — the page the clear and the write are bounded at, so a
// deliberately multi-page batch is built from the real number.
import { CHECKLIST_CANDIDATE_PAGE } from "./checklistCandidates";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin_195", role: "admin" };
// A second operator on the same shared set — the whole point of the isolation
// suite below. Two admins syncing one selectorOption is the real workflow, not
// a contrived one: the sets are shared and the fetch takes ~80s.
const OTHER_ADMIN = { subject: "admin_other", role: "admin" };

async function seedRow(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      lastUpdated: Date.now(),
    }),
  );
}

function cand(
  cardNumber: string,
  bscRef: string,
  extra: { isVariation?: boolean; cardVariation?: string } = {},
) {
  return {
    cardNumber,
    cardName: `Card ${cardNumber}`,
    platformData: { bsc: { ref: bscRef } },
    bucket: "matched" as const,
    ...extra,
  };
}

async function startBatch(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  candidates: ReturnType<typeof cand>[],
  readyImmediately = false,
  opts: { userId?: string; batchId?: string } = {},
) {
  return t.mutation(internal.checklistCandidates.startCandidateBatch, {
    selectorOptionId,
    batchId: opts.batchId ?? "batch-1",
    userId: opts.userId ?? ADMIN.subject,
    candidates,
    readyImmediately,
  });
}

/** The modal's read, as a given operator. */
async function readAs(
  t: ReturnType<typeof convexTest>,
  identity: { subject: string; role: string },
  selectorOptionId: Id<"selectorOptions">,
) {
  return t
    .withIdentity(identity)
    .query(api.checklistCandidates.getReadyCandidates, { selectorOptionId });
}

describe("candidates are visible immediately; teams fill in behind them", () => {
  test("cards are shown before their teams resolve", async () => {
    // Pairing does not need a team, and Confirm is separately blocked while
    // the fetch runs — so withholding rows only cost the operator the head
    // start the streaming exists to give them.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")]);

    const res = await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.total).toBe(2);
    expect(res.cards).toHaveLength(2);
    // …but they are marked as still enriching, so the UI can say so.
    expect(res.ready).toBe(0);
    expect(res.cards.every((c) => c.teamResolved === false)).toBe(true);
  });

  test("a resolved team lands on the card that was already visible", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")]);

    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      resolved: [{ bscRef: "b1", teamName: "Phillies" }],
    });

    const res = await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.ready).toBe(1);
    const one = res.cards.find((c) => c.cardNumber === "1")!;
    expect(one.teams).toEqual(["Phillies"]);
    expect(one.teamResolved).toBe(true);
    // The other card is still listed, still enriching.
    expect(res.cards.find((c) => c.cardNumber === "2")!.teamResolved).toBe(false);
  });

  test("an EMPTY team result still releases the card", async () => {
    // BSC genuinely has no team for an insert or a checklist card. Treating
    // that as unresolved would strand the row — and with group gating, its
    // whole stem.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1")]);

    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      resolved: [{ bscRef: "b1", teamName: undefined }],
    });

    const res = await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.ready).toBe(1);
    expect(res.cards[0].teams).toBeUndefined();
    expect(res.cards[0].teamResolved).toBe(true);
  });

  test("a fetch needing no lookups is reviewable immediately", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")], true);

    const res = await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.ready).toBe(2);
  });
});

describe("a parent and its variations arrive together", () => {
  test("a card and its variations are all present from the first read", async () => {
    // Pairing #20b sensibly requires seeing #20 and #20c at the same time.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [
      cand("20", "b20"),
      cand("20b", "b20b", { isVariation: true, cardVariation: "Factory Set" }),
      cand("21", "b21"),
    ]);

    const res = await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.cards.map((c) => c.cardNumber).sort()).toEqual([
      "20",
      "20b",
      "21",
    ]);
    // They share a stem, which is what keeps them grouped downstream.
    const stems = new Map(res.cards.map((c) => [c.cardNumber, c.stem]));
    expect(stems.get("20")).toBe(stems.get("20b"));
    expect(stems.get("21")).not.toBe(stems.get("20"));
  });

  test("teams resolving for one member does not disturb the others", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [
      cand("20", "b20"),
      cand("20b", "b20b", { isVariation: true, cardVariation: "Factory Set" }),
    ]);

    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      resolved: [{ bscRef: "b20", teamName: "Orioles" }],
    });
    const res = await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.cards).toHaveLength(2);
    expect(res.ready).toBe(1);
  });
});

describe("batch lifecycle", () => {
  test("starting a batch clears a previous run's candidates", async () => {
    // A re-sync before cancelling would otherwise interleave two runs, the
    // older one referencing marketplace state that no longer exists.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")], true);

    const res = await t.mutation(
      internal.checklistCandidates.startCandidateBatch,
      {
        selectorOptionId: id,
        batchId: "batch-2",
        userId: "admin_195",
        candidates: [cand("9", "b9")],
        readyImmediately: true,
      },
    );
    expect(res.cleared).toBe(2);

    const view = await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(view.total).toBe(1);
    expect(view.batchId).toBe("batch-2");
    expect(view.cards[0].cardNumber).toBe("9");
  });

  test("discard empties the batch and requires an admin", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1")], true);

    await expect(
      t.mutation(api.checklistCandidates.discardCandidates, {
        selectorOptionId: id,
      }),
    ).rejects.toThrow();

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.checklistCandidates.discardCandidates, {
        selectorOptionId: id,
      });
    expect(res.deleted).toBe(1);
    expect(
      (
        await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
          selectorOptionId: id,
        })
      ).total,
    ).toBe(0);
  });

  test("an untouched row reports nothing rather than erroring", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const res = await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res).toEqual({ batchId: undefined, total: 0, ready: 0, cards: [] });
  });
});

describe("sweepStaleCandidates — the run that never finished", () => {
  test("reaps rows older than the threshold and leaves fresh ones", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")], true);

    // Age one row past the cutoff; a live fetch is never near it.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("checklistCandidates").collect();
      await ctx.db.patch(rows[0]._id, {
        lastUpdated: Date.now() - 2 * 60 * 60 * 1000,
      });
    });

    const res = await t.mutation(
      internal.checklistCandidates.sweepStaleCandidates,
      {},
    );
    expect(res.deleted).toBe(1);
    expect(
      (
        await t.withIdentity(ADMIN).query(api.checklistCandidates.getReadyCandidates, {
          selectorOptionId: id,
        })
      ).total,
    ).toBe(1);
  });

  test("a fetch in progress is never touched", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")]);

    const res = await t.mutation(
      internal.checklistCandidates.sweepStaleCandidates,
      {},
    );
    expect(res.deleted).toBe(0);
  });
});


describe("two operators on the same set do not destroy each other's work", () => {
  // The bug this pins: `startCandidateBatch` cleared every row for the
  // selectorOption regardless of who wrote it, and `getReadyCandidates` read
  // the same way. So the second operator to hit Sync deleted the first one's
  // in-flight candidates, and the first one's modal — subscribed to this very
  // query — emptied mid-review. No error, just a lost 900-card reconciliation.

  test("B's fetch neither clears nor surfaces A's candidates", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);

    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2"), cand("3", "b3")],
      true, { userId: ADMIN.subject, batchId: "batch-a" });
    const b = await startBatch(t, id, [cand("7", "b7"), cand("8", "b8")], true, {
      userId: OTHER_ADMIN.subject,
      batchId: "batch-b",
    });

    // Nothing of A's was in scope for B's clear.
    expect(b.cleared).toBe(0);

    const aView = await readAs(t, ADMIN, id);
    expect(aView.total).toBe(3);
    expect(aView.batchId).toBe("batch-a");
    expect(aView.cards.map((c) => c.cardNumber).sort()).toEqual(["1", "2", "3"]);

    const bView = await readAs(t, OTHER_ADMIN, id);
    expect(bView.total).toBe(2);
    expect(bView.batchId).toBe("batch-b");
    expect(bView.cards.map((c) => c.cardNumber).sort()).toEqual(["7", "8"]);
  });

  test("a re-run by the SAME operator still replaces only their own batch", async () => {
    // The original intent survives the scoping: interleaving two of your own
    // runs is still the thing being prevented.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);

    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")], true, {
      userId: ADMIN.subject,
      batchId: "batch-a1",
    });
    await startBatch(t, id, [cand("7", "b7")], true, {
      userId: OTHER_ADMIN.subject,
      batchId: "batch-b",
    });

    const again = await startBatch(t, id, [cand("9", "b9")], true, {
      userId: ADMIN.subject,
      batchId: "batch-a2",
    });
    expect(again.cleared).toBe(2); // A's own two rows, and only those.

    const aView = await readAs(t, ADMIN, id);
    expect(aView.total).toBe(1);
    expect(aView.cards[0].cardNumber).toBe("9");
    expect((await readAs(t, OTHER_ADMIN, id)).total).toBe(1);
  });

  test("A cancelling does not empty B's open modal", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")], true, {
      userId: ADMIN.subject,
      batchId: "batch-a",
    });
    await startBatch(t, id, [cand("7", "b7")], true, {
      userId: OTHER_ADMIN.subject,
      batchId: "batch-b",
    });

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.checklistCandidates.discardCandidates, {
        selectorOptionId: id,
      });
    expect(res.deleted).toBe(2);

    expect((await readAs(t, ADMIN, id)).total).toBe(0);
    expect((await readAs(t, OTHER_ADMIN, id)).total).toBe(1);
  });

  test("an unauthenticated read sees nothing rather than everything", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1")], true);

    const res = await t.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res).toEqual({ batchId: undefined, total: 0, ready: 0, cards: [] });
  });
});

// ===========================================================================
// NEO-294 — writing and clearing a batch are bounded
//
// Convex counts one system operation per CALL, and `startCandidateBatch` made
// one per card TWICE: it deleted the operator's previous rows and inserted the
// new ones in a single transaction. A re-sync of the ~900-card set the seed job
// runs is ~1,801 operations, which `CARDS_PER_COMMIT_CHUNK` measured as
// straining — and the whole candidate array arrives in ONE `ctx.runMutation`,
// so nothing was bounding it.
//
// What these pin: a transaction writes at most one page, the CLEAR still
// finishes before the first row is written, the chain converges on exactly the
// cards it was given, and a small batch is still one call.
// ===========================================================================

describe("candidate writes are bounded and chain (NEO-294)", () => {
  /** `count` distinct candidates — more than one transaction may write. */
  function manyCandidates(count: number) {
    return Array.from({ length: count }, (_, i) => cand(`${i}`, `bsc-${i}`));
  }

  /** The pending continuations `startCandidateBatch` armed for itself. */
  async function scheduledWrites(
    t: ReturnType<typeof convexTest>,
  ): Promise<Array<{ from?: number }>> {
    return t.run(async (ctx) => {
      const rows = await (
        ctx as unknown as {
          db: {
            system: {
              query: (n: string) => {
                collect: () => Promise<
                  Array<{ name: string; args: Array<{ from?: number }> }>
                >;
              };
            };
          };
        }
      ).db.system.query("_scheduled_functions").collect();
      return rows
        .filter((r) => r.name === "checklistCandidates:startCandidateBatch")
        .map((r) => r.args[0]);
    });
  }

  async function countRows(t: ReturnType<typeof convexTest>): Promise<number> {
    return t.run(
      async (ctx) => (await ctx.db.query("checklistCandidates").collect()).length,
    );
  }

  test("a batch bigger than one page writes a page and arms the rest", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const candidates = manyCandidates(CHECKLIST_CANDIDATE_PAGE + 40);

    const res = await startBatch(t, id, candidates, true);

    expect(res.written).toBe(CHECKLIST_CANDIDATE_PAGE);
    expect(res.hasMore).toBe(true);
    expect(await countRows(t)).toBe(CHECKLIST_CANDIDATE_PAGE);
    // The continuation names the next card rather than carrying a cursor that
    // could go stale — the array it walks is re-passed unchanged.
    expect((await scheduledWrites(t)).map((a) => a.from)).toEqual([
      CHECKLIST_CANDIDATE_PAGE,
    ]);
  });

  test("the chain finishes the batch, with one row per card and no duplicates", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const candidates = manyCandidates(CHECKLIST_CANDIDATE_PAGE + 40);

    await startBatch(t, id, candidates, true);
    await t.finishAllScheduledFunctions(() => {});

    expect(await countRows(t)).toBe(candidates.length);
    const view = await readAs(t, ADMIN, id);
    expect(view.total).toBe(candidates.length);
    expect(new Set(view.cards.map((c) => c.cardNumber)).size).toBe(
      candidates.length,
    );
  });

  test("an interrupted chain keeps the page it committed, and re-running the fetch converges", async () => {
    // Each page commits on its own, so a chain that dies mid-way leaves the
    // rows it wrote rather than rolling them back — and the entry point at the
    // head is what makes recovery exact: it CLEARS this operator's rows before
    // it writes, so re-running the fetch can never leave two copies of a card.
    //
    // (There is no "replayed page" case to defend against. A page is a Convex
    // transaction: it either committed or it wrote nothing at all, and the
    // scheduler runs each link once.)
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const candidates = manyCandidates(CHECKLIST_CANDIDATE_PAGE + 10);

    // The first page commits; its continuation is still armed.
    await startBatch(t, id, candidates, true);
    expect(await countRows(t)).toBe(CHECKLIST_CANDIDATE_PAGE);

    // The operator syncs again. Same cards, a new batch id. The clear at the
    // head takes the old batch with it, and the orphaned continuation then
    // finds nothing of its own batch left and writes nothing — so draining
    // everything afterwards cannot resurrect a dead batch beside the live one.
    await startBatch(t, id, candidates, true, { batchId: "batch-2" });
    await t.finishAllScheduledFunctions(() => {});

    expect(await countRows(t)).toBe(candidates.length);
    const view = await readAs(t, ADMIN, id);
    expect(view.batchId).toBe("batch-2");
    expect(new Set(view.cards.map((c) => c.cardNumber)).size).toBe(
      candidates.length,
    );
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("checklistCandidates").collect()).filter(
          (r) => r.batchId !== "batch-2",
        ),
      ),
    ).toHaveLength(0);
  });

  test("a continuation whose batch has been cleared writes nothing", async () => {
    // The one window paging opened: a link of an abandoned chain landing after
    // a cancel, or after the next sync cleared the table. Inserted blind, those
    // rows would surface in the modal beside the live batch — the interleaving
    // the clear exists to prevent, through the back door.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const candidates = manyCandidates(CHECKLIST_CANDIDATE_PAGE + 10);
    await startBatch(t, id, candidates, true);

    await t
      .withIdentity(ADMIN)
      .mutation(api.checklistCandidates.discardCandidates, {
        selectorOptionId: id,
      });
    expect(await countRows(t)).toBe(0);

    await t.finishAllScheduledFunctions(() => {});

    expect(await countRows(t)).toBe(0);
  });

  test("a batch that fits in one page is still one call", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);

    const res = await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")], true);

    expect(res).toEqual({ written: 2, cleared: 0, hasMore: false });
    expect(await scheduledWrites(t)).toHaveLength(0);
  });

  test("a clear bigger than one page finishes BEFORE the new batch is written", async () => {
    // The ordering the clear exists for: a modal showing two runs' candidates
    // interleaved, the older ones pointing at marketplace state that is gone.
    // A half-cleared table is exactly that, so the write phase does not start
    // until the clear has.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const previous = manyCandidates(CHECKLIST_CANDIDATE_PAGE + 30);
    await startBatch(t, id, previous, true);
    await t.finishAllScheduledFunctions(() => {});
    expect(await countRows(t)).toBe(previous.length);

    const res = await t.mutation(
      internal.checklistCandidates.startCandidateBatch,
      {
        selectorOptionId: id,
        batchId: "batch-2",
        userId: ADMIN.subject,
        candidates: [cand("9", "b9")],
        readyImmediately: true,
      },
    );

    // Nothing of the new batch yet — this transaction only cleared.
    expect(res.written).toBe(0);
    expect(res.cleared).toBe(CHECKLIST_CANDIDATE_PAGE);
    expect(res.hasMore).toBe(true);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("checklistCandidates").collect()).filter(
          (r) => r.batchId === "batch-2",
        ),
      ),
    ).toHaveLength(0);

    await t.finishAllScheduledFunctions(() => {});
    const view = await readAs(t, ADMIN, id);
    expect(view.batchId).toBe("batch-2");
    expect(view.total).toBe(1);
  });

  test("discard clears a page and the tail empties the rest", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const candidates = manyCandidates(CHECKLIST_CANDIDATE_PAGE + 15);
    await startBatch(t, id, candidates, true);
    await t.finishAllScheduledFunctions(() => {});

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.checklistCandidates.discardCandidates, {
        selectorOptionId: id,
      });

    expect(res.deleted).toBe(CHECKLIST_CANDIDATE_PAGE);
    expect(res.hasMore).toBe(true);
    expect(await countRows(t)).toBe(candidates.length - CHECKLIST_CANDIDATE_PAGE);

    await t.finishAllScheduledFunctions(() => {});
    expect(await countRows(t)).toBe(0);
  });

  test("a discard that fits in one page schedules no tail", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1")], true);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.checklistCandidates.discardCandidates, {
        selectorOptionId: id,
      });

    expect(res).toEqual({ deleted: 1, hasMore: false });
    expect(await countRows(t)).toBe(0);
  });

  test("the stale sweep bounds its DELETES, not just its scan", async () => {
    // `take(2000)` costs one operation however many rows it returns; the
    // per-row cost was always the delete behind it. Two abandoned ~900-card
    // fetches in one transaction is the shape that strains.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const candidates = manyCandidates(CHECKLIST_CANDIDATE_PAGE + 20);
    await startBatch(t, id, candidates, true);
    await t.finishAllScheduledFunctions(() => {});
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("checklistCandidates").collect()) {
        await ctx.db.patch(row._id, {
          lastUpdated: Date.now() - 2 * 60 * 60 * 1000,
        });
      }
    });

    const first = await t.mutation(
      internal.checklistCandidates.sweepStaleCandidates,
      {},
    );
    expect(first.deleted).toBe(CHECKLIST_CANDIDATE_PAGE);
    expect(first.hasMore).toBe(true);

    // Restarting from the top converges: the rows it deletes leave the table.
    const second = await t.mutation(
      internal.checklistCandidates.sweepStaleCandidates,
      {},
    );
    expect(second.hasMore).toBe(false);
    expect(await countRows(t)).toBe(0);
  });
});

// ===========================================================================
// NEO-294 — a team lookup that lands before the row it belongs to
//
// Paging the write means a `bscRef` a lookup chunk resolved can, for a few
// milliseconds of a very large sync, belong to a row that has not been written
// yet. Skipping it silently would lose that card's team with no trace and
// nothing re-asks BSC, so a miss is retried once and then reported.
// ===========================================================================

describe("resolveCandidateTeams survives a row that is not written yet (NEO-294)", () => {
  // The retry is scheduled with a real DELAY — `runAfter(0)` would land in the
  // same millisecond the write chain is still in, which is the whole point of
  // having it. `finishAllScheduledFunctions` can only force a function whose
  // time has passed, so these two tests drive a fake clock.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function scheduledRetries(
    t: ReturnType<typeof convexTest>,
  ): Promise<number> {
    return t.run(async (ctx) => {
      const rows = await (
        ctx as unknown as {
          db: {
            system: {
              query: (n: string) => {
                collect: () => Promise<Array<{ name: string }>>;
              };
            };
          };
        }
      ).db.system.query("_scheduled_functions").collect();
      return rows.filter(
        (r) => r.name === "checklistCandidates:resolveCandidateTeams",
      ).length;
    });
  }

  test("a ref with no row yet is retried once, and the retry lands the team", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1")]);

    // "b2" has no row yet — the write chain has not reached it.
    const first = await t.mutation(
      internal.checklistCandidates.resolveCandidateTeams,
      {
        batchId: "batch-1",
        resolved: [
          { bscRef: "b1", teamName: "Orioles" },
          { bscRef: "b2", teamName: "Padres" },
        ],
      },
    );
    expect(first.patched).toBe(1);
    expect(first.missing).toBe(1);
    expect(await scheduledRetries(t)).toBe(1);

    // The row arrives on a later page of the write chain — `from` past the
    // card already written, so the clear at the head does not run and the
    // first card stays put.
    await t.mutation(internal.checklistCandidates.startCandidateBatch, {
      selectorOptionId: id,
      batchId: "batch-1",
      userId: ADMIN.subject,
      candidates: [cand("1", "b1"), cand("2", "b2")],
      readyImmediately: false,
      from: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const view = await readAs(t, ADMIN, id);
    const two = view.cards.find((c) => c.cardNumber === "2");
    expect(two?.teams).toEqual(["Padres"]);
    expect(two?.teamResolved).toBe(true);
  });

  test("the retry never chains — a ref for a row that was DELETED stops there", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1")]);

    const retry = await t.mutation(
      internal.checklistCandidates.resolveCandidateTeams,
      {
        batchId: "batch-1",
        resolved: [{ bscRef: "gone", teamName: "Padres" }],
        retry: true,
      },
    );

    expect(retry.missing).toBe(1);
    expect(await scheduledRetries(t)).toBe(0);
  });
});
