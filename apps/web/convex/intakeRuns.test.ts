/**
 * NEO-379 — intake runs and the server-side matcher, end to end in
 * convex-test: a run over a placeholder job, pairs matched in the run's
 * variant as they change, a collector's pick that no sync overwrites, repeats
 * flagged, and every public function refusing another collector's run.
 *
 * The matching rules themselves are pinned in `lib/intakeMatch.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { insertTestCard } from "../lib/testing/card-row";
import { noteIntakePairsChanged } from "./intakeRuns";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "user_intakeMe0001" };
const THEM = { subject: "user_intakeThem002" };
const JOB = "job-intake-1";

let harnesses: Array<ReturnType<typeof convexTest>> = [];
afterEach(async () => {
  for (const t of harnesses) await drainScheduled(t);
  harnesses = [];
});

interface Scan {
  number?: string;
  players?: string[];
}

/**
 * A finished placeholder job of ME's with one manual pair per scan (front at
 * 2i, back at 2i+1), the catalog fixture, and a box of ME's.
 */
async function world(scans: Scan[]) {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  const fx = await seedCollectionCatalog(t);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: JOB,
      userId: ME.subject,
      objectPath: `placeholders/${ME.subject}/${JOB}/`,
      createdAt: 0,
      mode: "stream",
      status: "succeeded",
    });
    const pairIds: Id<"placeholderPairs">[] = [];
    for (const [i, scan] of scans.entries()) {
      for (const [k, side] of (["front", "back"] as const).entries()) {
        await ctx.db.insert("placeholderImages", {
          jobId: JOB,
          userId: ME.subject,
          entryIndex: 2 * i + k,
          originalName: `scan-${i}-${side}.jpg`,
          status: "done",
          side,
          players: side === "front" ? scan.players : undefined,
          cardNumber: side === "back" ? scan.number : undefined,
          pairStatus: "paired",
        });
      }
      pairIds.push(
        await ctx.db.insert("placeholderPairs", {
          jobId: JOB,
          userId: ME.subject,
          frontIndex: 2 * i,
          backIndex: 2 * i + 1,
          player: scan.players?.[0],
          cardNumber: scan.number,
          confidence: "side-only",
          mechanism: "manual",
          score: 0,
        }),
      );
    }
    const boxId = await ctx.db.insert("collectionContainers", {
      ownerId: ME.subject,
      kind: "box",
      name: "For sale",
      lastUpdated: 0,
    });
    const theirBoxId = await ctx.db.insert("collectionContainers", {
      ownerId: THEM.subject,
      kind: "box",
      name: "Their box",
      lastUpdated: 0,
    });
    return { pairIds, boxId, theirBoxId };
  });
  return { t, fx, ...ids, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}

async function startRun(
  w: Awaited<ReturnType<typeof world>>,
  variantId?: Id<"selectorOptions">,
) {
  const runId = await w.me.mutation(api.intakeRuns.createIntakeRun, {
    jobId: JOB,
    homeId: w.boxId,
    variantId,
    defaults: { condition: "Near Mint", costCents: 10, location: "  Shelf 2  " },
  });
  await drainScheduled(w.t);
  return runId;
}

const byPair = async (
  w: Awaited<ReturnType<typeof world>>,
  runId: Id<"intakeRuns">,
) => {
  const rows = await w.me.query(api.intakeRuns.listIntakeMatches, { runId });
  return new Map(rows.map((r) => [r.pairId, r]));
};

describe("matching a run's pairs", () => {
  test("each pair is matched in the run's variant, with variations and repeats", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "2", players: ["D. Strawberry"] },
      { number: "77", players: ["Nobody Known"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    const rows = await byPair(w, runId);
    const [a, b, c, d] = w.pairIds.map((id) => rows.get(id)!);

    expect(a).toMatchObject({ cardId: w.fx.gooden1, band: "matched", reason: "numberAndPlayer" });
    expect(a.variations.map((v) => v._id)).toEqual([w.fx.gooden1Sliding]);
    expect(a.variations[0].variation).toBe("Sliding");
    expect(b).toMatchObject({ cardId: w.fx.strawberry2, band: "matched" });
    expect(b.repeatOfPairId).toBeUndefined();
    // The same card scanned again is flagged against the earlier pair.
    expect(c).toMatchObject({ cardId: w.fx.strawberry2, repeatOfPairId: w.pairIds[1] });
    expect(d).toMatchObject({ band: "none", reason: "noMatch" });
    expect(d.cardId).toBeUndefined();
  });

  test("You have N here counts the copies in the run's home only", async () => {
    const w = await world([{ number: "2", players: ["Darryl Strawberry"] }]);
    await w.t.run(async (ctx) => {
      for (const [homeId, quantity] of [[w.boxId, 3], [w.boxId, 1]] as const) {
        await ctx.db.insert("collectionCopies", {
          ownerId: ME.subject,
          cardId: w.fx.strawberry2,
          homeId,
          quantity,
          lastUpdated: 0,
        });
      }
      const binder = await ctx.db.insert("collectionContainers", {
        ownerId: ME.subject,
        kind: "binder",
        name: "Elsewhere",
        lastUpdated: 0,
      });
      await ctx.db.insert("collectionCopies", {
        ownerId: ME.subject,
        cardId: w.fx.strawberry2,
        homeId: binder,
        quantity: 5,
        lastUpdated: 0,
      });
    });
    const runId = await startRun(w, w.fx.baseId);
    const rows = await byPair(w, runId);
    expect(rows.get(w.pairIds[0])!.haveHere).toBe(4);
  });

  test("with no variant nothing is matched until one is pinned", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w);
    let row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row).toMatchObject({ band: "none", reason: "noVariant" });

    await w.me.mutation(api.intakeRuns.setIntakeRunVariant, {
      runId,
      variantId: w.fx.baseId,
      pinned: true,
    });
    await drainScheduled(w.t);
    row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row).toMatchObject({ cardId: w.fx.gooden1, band: "matched" });
    const run = await w.me.query(api.intakeRuns.getIntakeRun, { runId });
    expect(run).toMatchObject({ variantName: "Base", variantPinned: true, homeKind: "box" });
    // Free text defaults are trimmed.
    expect(run?.defaults).toMatchObject({ condition: "Near Mint", costCents: 10, location: "Shelf 2" });
  });

  test("a collector's pick survives a pair that changes; clearing it re-matches", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    await w.me.mutation(api.intakeRuns.pickIntakeCard, {
      runId,
      pairId: w.pairIds[0],
      cardId: w.fx.gooden1Sliding,
    });
    // A swap re-merges the pair's identity and notes the change.
    await w.me.mutation(api.placeholderPairing.swapPairSides, {
      jobId: JOB,
      frontIndex: 0,
      backIndex: 1,
    });
    await drainScheduled(w.t);
    let row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row).toMatchObject({ cardId: w.fx.gooden1Sliding, byUser: true, reason: "byUser" });

    await w.me.mutation(api.intakeRuns.pickIntakeCard, { runId, pairId: w.pairIds[0], cardId: null });
    await drainScheduled(w.t);
    row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row.byUser).toBeUndefined();
    expect(row.reason).not.toBe("byUser");
  });

  test("a pair that is gone takes its match with it", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    await w.t.run(async (ctx) => {
      await ctx.db.delete(w.pairIds[0]);
      await noteIntakePairsChanged(ctx, JOB);
    });
    await drainScheduled(w.t);
    const rows = await byPair(w, runId);
    expect([...rows.keys()]).toEqual([w.pairIds[1]]);
  });

  test("a job with no run queues nothing when its pairs change", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    await w.me.mutation(api.placeholderPairing.swapPairSides, {
      jobId: JOB,
      frontIndex: 0,
      backIndex: 1,
    });
    const queued = await w.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.name),
    );
    expect(queued.filter((n) => n.includes("intakeRuns"))).toEqual([]);
  });

  test("one run per job: starting again returns the same run", async () => {
    const w = await world([{ number: "1" }]);
    const first = await startRun(w, w.fx.baseId);
    const again = await startRun(w, w.fx.baseId);
    expect(again).toBe(first);
    const runs = await w.me.query(api.intakeRuns.listMyIntakeRuns, {});
    expect(runs.map((r) => r._id)).toEqual([first]);
  });
});

describe("ownership", () => {
  test("another collector's job, home or run is refused", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    await expect(
      w.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: w.theirBoxId }),
    ).rejects.toThrow(/not found/);
    await expect(
      w.them.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: w.theirBoxId }),
    ).rejects.toThrow(/Job not found/);
    await expect(
      w.t.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: w.boxId }),
    ).rejects.toThrow(/Not authenticated/);

    const runId = await startRun(w, w.fx.baseId);
    expect(await w.them.query(api.intakeRuns.getIntakeRun, { runId })).toBeNull();
    expect(await w.them.query(api.intakeRuns.listIntakeMatches, { runId })).toEqual([]);
    expect(await w.them.query(api.intakeRuns.listMyIntakeRuns, {})).toEqual([]);
    expect(await w.t.query(api.intakeRuns.getIntakeRun, { runId })).toBeNull();
    await expect(
      w.them.mutation(api.intakeRuns.pickIntakeCard, {
        runId,
        pairId: w.pairIds[0],
        cardId: w.fx.gooden1,
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      w.them.mutation(api.intakeRuns.setIntakeRunVariant, { runId, variantId: w.fx.baseId }),
    ).rejects.toThrow(/not found/);
    await expect(
      w.them.mutation(api.intakeRuns.setIntakeRunDefaults, { runId, defaults: {} }),
    ).rejects.toThrow(/not found/);
  });

  test("a variant with no cards, and a negative price, are refused", async () => {
    const w = await world([{ number: "1" }]);
    await expect(
      w.me.mutation(api.intakeRuns.createIntakeRun, {
        jobId: JOB,
        homeId: w.boxId,
        variantId: w.fx.setId,
      }),
    ).rejects.toThrow(/no cards/);
    await expect(
      w.me.mutation(api.intakeRuns.createIntakeRun, {
        jobId: JOB,
        homeId: w.boxId,
        defaults: { minPriceCents: -5 },
      }),
    ).rejects.toThrow(/Minimum price/);
  });
});


describe("the collector's answers (NEO-382)", () => {
  const copiesOf = (w: Awaited<ReturnType<typeof world>>, cardId: Id<"cardChecklist">) =>
    w.t.run(async (ctx) =>
      (await ctx.db.query("collectionCopies").collect()).filter((c) => c.cardId === cardId),
    );

  test("a save files the copies with the run's defaults, once", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    const first = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 2,
      details: { notes: "From the show" },
    });
    expect(first.alreadySaved).toBe(false);
    // A double click (or a retried request) adds nothing.
    const again = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 2,
    });
    expect(again).toEqual({ copyId: first.copyId, alreadySaved: true });

    const copies = await copiesOf(w, w.fx.gooden1);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      homeId: w.boxId,
      quantity: 2,
      condition: "Near Mint",
      costCents: 10,
      location: "Shelf 2",
      notes: "From the show",
    });
    const row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row).toMatchObject({ savedCopyId: first.copyId, savedQuantity: 2, haveHere: 2 });
    // A saved card is not re-picked.
    await expect(
      w.me.mutation(api.intakeRuns.pickIntakeCard, { runId, pairId: w.pairIds[0], cardId: null }),
    ).rejects.toThrow(/already saved/);
  });

  test("a save folds into an identical line already in the home", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("collectionCopies", {
        ownerId: ME.subject,
        cardId: w.fx.gooden1,
        homeId: w.boxId,
        quantity: 3,
        condition: "Near Mint",
        costCents: 10,
        location: "Shelf 2",
        lastUpdated: 0,
      });
    });
    const runId = await startRun(w, w.fx.baseId);
    const saved = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 1,
    });
    const copies = await copiesOf(w, w.fx.gooden1);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ _id: saved.copyId, quantity: 4 });
  });

  test("a double scan must be answered: a second copy saves, a re-scan is set aside", async () => {
    const w = await world([
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "2", players: ["Darryl Strawberry"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    await expect(
      w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[1], quantity: 1 }),
    ).rejects.toThrow(/second copy/);
    // The first scan of the card is no repeat, so there is nothing to answer.
    await expect(
      w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[0], secondCopy: true }),
    ).rejects.toThrow(/isn't a repeat/);

    await w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[1], secondCopy: true });
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[1], quantity: 1 });

    await w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[2], secondCopy: false });
    await expect(
      w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[2], quantity: 1 }),
    ).rejects.toThrow(/set aside/);

    const rows = await byPair(w, runId);
    expect(rows.get(w.pairIds[1])).toMatchObject({ repeatIsSecondCopy: true, savedQuantity: 1 });
    expect(rows.get(w.pairIds[2])).toMatchObject({ setAside: true });
    expect((await copiesOf(w, w.fx.strawberry2)).reduce((n, c) => n + c.quantity, 0)).toBe(1);

    // Brought back, the re-scan asks again.
    await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[2], setAside: false });
    const back = (await byPair(w, runId)).get(w.pairIds[2])!;
    expect(back.setAside).toBeUndefined();
    expect(back.repeatOfPairId).toBe(w.pairIds[0]);
  });

  test("a pair with no card, or a bad quantity, does not save", async () => {
    const w = await world([
      { number: "77", players: ["Nobody Known"] },
      { number: "1", players: ["Doc Gooden"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    await expect(
      w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 }),
    ).rejects.toThrow(/Pick the card/);
    for (const quantity of [0, 1.5, 100_000]) {
      await expect(
        w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[1], quantity }),
      ).rejects.toThrow(/between 1/);
    }
  });

  test("the search finds the variant's cards by number, then by name", async () => {
    const w = await world([{ number: "1" }]);
    const runId = await startRun(w, w.fx.baseId);
    const byNumber = await w.me.query(api.intakeRuns.searchIntakeCards, { runId, q: "#002" });
    expect(byNumber.map((c) => c._id)).toEqual([w.fx.strawberry2]);
    const byName = await w.me.query(api.intakeRuns.searchIntakeCards, { runId, q: "gooden" });
    expect(byName.map((c) => c._id)).toEqual(expect.arrayContaining([w.fx.gooden1]));
    expect(await w.them.query(api.intakeRuns.searchIntakeCards, { runId, q: "1" })).toEqual([]);
  });

  test("a saved or set-aside card is never re-matched; a second-copy answer is asked again when the match moves", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "1", players: ["Doc Gooden"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 });
    await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
    await w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[2], secondCopy: true });

    // A new variant re-matches every open card, and only those.
    await w.me.mutation(api.intakeRuns.setIntakeRunVariant, { runId, variantId: w.fx.goldId, pinned: true });
    await drainScheduled(w.t);
    const rows = await byPair(w, runId);
    expect(rows.get(w.pairIds[0])).toMatchObject({ cardId: w.fx.gooden1, savedQuantity: 1 });
    expect(rows.get(w.pairIds[1])).toMatchObject({ cardId: w.fx.strawberry2, setAside: true });
    const moved = rows.get(w.pairIds[2])!;
    expect(moved.cardId).toBe(w.fx.gold1);
    expect(moved.repeatIsSecondCopy).toBeUndefined();

    // A saved card takes no more answers.
    await expect(
      w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[0], setAside: true }),
    ).rejects.toThrow(/already saved/);
    await expect(
      w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[0], secondCopy: false }),
    ).rejects.toThrow(/already saved/);
  });

  test("a save takes up to 999 copies, and a per-card detail left out keeps the run's", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 999,
      details: { condition: undefined, location: "Binder 4" },
    });
    const [copy] = await copiesOf(w, w.fx.gooden1);
    expect(copy).toMatchObject({ quantity: 999, condition: "Near Mint", location: "Binder 4" });
    const row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row.card).toMatchObject({ _id: w.fx.gooden1, cardNumber: "1" });
  });

  test("the search: no variant finds nothing, an empty search lists the variant, at most 8", async () => {
    const w = await world([{ number: "1" }, { number: "77", players: ["Nobody Known"] }]);
    const bare = await startRun(w);
    expect(await w.me.query(api.intakeRuns.searchIntakeCards, { runId: bare, q: "1" })).toEqual([]);
    expect((await byPair(w, bare)).get(w.pairIds[1])!.card).toBeNull();

    await w.me.mutation(api.intakeRuns.setIntakeRunVariant, { runId: bare, variantId: w.fx.baseId, pinned: true });
    const all = await w.me.query(api.intakeRuns.searchIntakeCards, { runId: bare, q: "  " });
    expect(all.map((c) => c._id)).toEqual(
      expect.arrayContaining([w.fx.gooden1, w.fx.strawberry2, w.fx.gooden1Sliding]),
    );
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) {
        await insertTestCard(ctx, {
          selectorOptionId: w.fx.baseId,
          cardNumber: `${100 + i}`,
          cardName: `Filler ${i}`,
          platformData: {},
          sortOrder: 100 + i,
          lastUpdated: 0,
        } as never);
      }
    });
    expect(await w.me.query(api.intakeRuns.searchIntakeCards, { runId: bare, q: "filler" })).toHaveLength(8);
  });

  test("another collector cannot save, answer or set aside", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    const pairId = w.pairIds[0];
    await expect(w.them.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId, quantity: 1 })).rejects.toThrow(/not found/);
    await expect(w.them.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId, secondCopy: true })).rejects.toThrow(/not found/);
    await expect(w.them.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId, setAside: true })).rejects.toThrow(/not found/);
  });
});

describe("the set builder reset", () => {
  test("drains intake matches and runs, matches first", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
    ]);
    await startRun(w, w.fx.baseId);
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    try {
      const r = await w.t.mutation(internal.selectorOptions.resetIntakeRunsBatch, {});
      expect(r).toEqual({ deleted: 3, hasMore: false });
    } finally {
      vi.unstubAllEnvs();
    }
    const left = await w.t.run(async (ctx) => [
      ...(await ctx.db.query("intakeMatches").collect()),
      ...(await ctx.db.query("intakeRuns").collect()),
    ]);
    expect(left).toEqual([]);
  });
});
