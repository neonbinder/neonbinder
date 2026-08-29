/**
 * NEO-195 — the readiness gate.
 *
 * The gate is the whole feature, not an optimisation: a card that appears
 * before its team resolves still LOOKS reviewable, so an operator either waits
 * anyway or approves something incomplete. These tests pin what may be shown.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

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
