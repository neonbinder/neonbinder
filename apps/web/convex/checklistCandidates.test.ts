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
) {
  return t.mutation(internal.checklistCandidates.startCandidateBatch, {
    selectorOptionId,
    batchId: "batch-1",
    userId: "admin_195",
    candidates,
    readyImmediately,
  });
}

describe("the gate withholds what is not reviewable", () => {
  test("nothing is shown while every card is still pending", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")]);

    const res = await t.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.total).toBe(2);
    expect(res.ready).toBe(0);
    expect(res.cards).toEqual([]);
  });

  test("a card is released once its team resolves", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")]);

    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      resolved: [{ bscRef: "b1", teamName: "Phillies" }],
    });

    const res = await t.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.ready).toBe(1);
    expect(res.cards[0].cardNumber).toBe("1");
    expect(res.cards[0].teams).toEqual(["Phillies"]);
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

    const res = await t.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.ready).toBe(1);
    expect(res.cards[0].teams).toBeUndefined();
  });

  test("a fetch needing no lookups is reviewable immediately", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [cand("1", "b1"), cand("2", "b2")], true);

    const res = await t.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.ready).toBe(2);
  });
});

describe("a parent and its variations are released together", () => {
  test("the parent is WITHHELD while one of its variations is pending", async () => {
    // Otherwise the operator reviews #20, moves on, and #20b appears
    // underneath it afterwards — worse than not streaming at all.
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    await startBatch(t, id, [
      cand("20", "b20"),
      cand("20b", "b20b", { isVariation: true, cardVariation: "Factory Set" }),
      cand("21", "b21"),
    ]);

    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      // #20 and #21 resolve; #20b has not.
      resolved: [
        { bscRef: "b20", teamName: "Orioles" },
        { bscRef: "b21", teamName: "Mets" },
      ],
    });

    const res = await t.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    // Only #21 — a stem of its own — is shown. Stem "20" is held back whole.
    expect(res.cards.map((c) => c.cardNumber)).toEqual(["21"]);
  });

  test("the whole stem appears at once when the last member resolves", async () => {
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
    expect(
      (
        await t.query(api.checklistCandidates.getReadyCandidates, {
          selectorOptionId: id,
        })
      ).ready,
    ).toBe(0);

    await t.mutation(internal.checklistCandidates.resolveCandidateTeams, {
      batchId: "batch-1",
      resolved: [{ bscRef: "b20b", teamName: "Orioles" }],
    });
    const res = await t.query(api.checklistCandidates.getReadyCandidates, {
      selectorOptionId: id,
    });
    expect(res.cards.map((c) => c.cardNumber).sort()).toEqual(["20", "20b"]);
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

    const view = await t.query(api.checklistCandidates.getReadyCandidates, {
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
        await t.query(api.checklistCandidates.getReadyCandidates, {
          selectorOptionId: id,
        })
      ).total,
    ).toBe(0);
  });

  test("an untouched row reports nothing rather than erroring", async () => {
    const t = convexTest(schema, modules);
    const id = await seedRow(t);
    const res = await t.query(api.checklistCandidates.getReadyCandidates, {
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
        await t.query(api.checklistCandidates.getReadyCandidates, {
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
