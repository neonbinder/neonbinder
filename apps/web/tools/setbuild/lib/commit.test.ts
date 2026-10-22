import { describe, expect, test } from "vitest";
import { fakeClient } from "../runner/fake-client";
import { buildParallel, BuildParallelError } from "./build-parallel";
import { checklistCount, checklistDone, runChecklistStep } from "./commit";
import { ChecklistStepError } from "./fetch-checklist";
import { pausedContextOf } from "./sync-column";

const CHECKLIST = {
  pairing: { unmatchedBsc: "keep" as const, unmatchedSportlots: "keep" as const },
  review: "none-expected" as const,
  expectCards: 335,
};

describe("checklist step idempotence", () => {
  test("an empty row is not done; the expected count is; any other count is refused", () => {
    expect(checklistDone(0, 335, "x")).toBe(false);
    expect(checklistDone(335, 335, "x")).toBe(true);
    expect(checklistDone(12, undefined, "x")).toBe(true);
    expect(() => checklistDone(300, 335, "x")).toThrow(ChecklistStepError);
  });

  test("a row already holding its cards is skipped before any marketplace call", async () => {
    const client = fakeClient().on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 335 });
    const r = await runChecklistStep(client, { rowId: "vtB" as never, sportId: "sp" as never, checklist: CHECKLIST, at: "a", row: null });
    expect(r).toMatchObject({ outcome: "skipped", cards: 335 });
    expect(client.calls.map((c) => c.fn)).toEqual(["selectorOptions:getSlotCardCounts"]);
  });

  test('"none-expected" with a review opened stops before the commit', async () => {
    let batch: string | undefined;
    const client = fakeClient()
      .on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 0 })
      .on("checklistCandidates:getReadyCandidates", () => ({ batchId: batch, total: batch ? 1 : 0, ready: 1, cards: batch ? [{ _id: "c1", cardNumber: "1", cardName: "A", platformData: { bsc: { ref: "b1" } }, bucket: "bscOnly", stem: "1", teamResolved: true }] : [] }))
      .on("selectorOptions:fetchCardChecklist", () => {
        batch = "cb";
        return { success: true, message: "", candidateCount: 1, attachedSides: ["bsc"], pausedSides: [] };
      })
      .on("selectorOptions:diffChecklistAgainstExisting", { cards: [], removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 }, conflicts: [], collisionInsertCount: 0 })
      .on("selectorOptions:resolveChecklistEntities", { unknownPlayers: ["A"], unknownTeams: [], batchId: "rb" })
      .on("entityReviewQueue:getBatch", [{ _id: "r1", kind: "player", name: "A", status: "ready", sportId: "sp" }])
      .on("players:nearMatches", []);
    const r = await runChecklistStep(client, { rowId: "vtB" as never, sportId: "sp" as never, checklist: CHECKLIST, at: "a", row: null });
    expect(r.outcome).toBe("open");
    expect(client.callsTo("selectorOptions:commitCardChecklist")).toEqual([]);
  });

  test("answers for a review that did not open are moot: committed, with a note (NEO-339)", async () => {
    let batch: string | undefined;
    let cards = 0;
    const client = fakeClient()
      .on("selectorOptions:getSlotCardCounts", () => ({ bsc: {}, sportlots: {}, total: cards }))
      .on("checklistCandidates:getReadyCandidates", () => ({ batchId: batch, total: batch ? 1 : 0, ready: 1, cards: batch ? [{ _id: "c1", cardNumber: "1", cardName: "A", platformData: { bsc: { ref: "b1" } }, bucket: "bscOnly", stem: "1", teamResolved: true }] : [] }))
      .on("selectorOptions:fetchCardChecklist", () => {
        batch = "cb";
        return { success: true, message: "", candidateCount: 1, attachedSides: ["bsc"], pausedSides: [] };
      })
      .on("selectorOptions:diffChecklistAgainstExisting", { cards: [], removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 }, conflicts: [], collisionInsertCount: 0 })
      // Mark McGwire is known by now: no review opens.
      .on("selectorOptions:resolveChecklistEntities", { unknownPlayers: [], unknownTeams: [] })
      .on("selectorOptions:commitCardChecklist", () => {
        cards = 1;
        return { count: 1, conflicts: [] };
      })
      .on("checklistCandidates:discardCandidates", null);
    const r = await runChecklistStep(client, {
      rowId: "i1" as never,
      sportId: "sp" as never,
      checklist: { ...CHECKLIST, expectCards: 1, review: { players: [{ name: "Mark McGwire", decision: "create" }], teams: [], leagues: [] } },
      at: "a",
      row: null,
    });
    expect(r).toMatchObject({ outcome: "committed", committed: 1 });
    if (r.outcome === "committed") expect(r.notes).toContain("1 review answer had nothing to answer (the name is known or not staged)");
  });

  test("a re-sync the review dialog would have to settle is refused", async () => {
    let batch: string | undefined;
    const client = fakeClient()
      .on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 0 })
      .on("checklistCandidates:getReadyCandidates", () => ({ batchId: batch, total: batch ? 1 : 0, ready: 1, cards: batch ? [{ _id: "c1", cardNumber: "1", cardName: "A", platformData: { bsc: { ref: "b1" } }, bucket: "bscOnly", stem: "1", teamResolved: true }] : [] }))
      .on("selectorOptions:fetchCardChecklist", () => {
        batch = "cb";
        return { success: true, message: "", candidateCount: 1, attachedSides: ["bsc"], pausedSides: [] };
      })
      .on("selectorOptions:diffChecklistAgainstExisting", {
        cards: [{ index: 0, cardNumber: "1", cardName: "A", bucket: "contentChanges", fields: [] }],
        removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 },
        conflicts: [],
        collisionInsertCount: 0,
      });
    client.on("selectorOptions:getAncestorChain", [
      { _id: "sp", level: "sport" },
      { _id: "yr", level: "year" },
      { _id: "mf", level: "manufacturer" },
      { _id: "st", level: "setName" },
      { _id: "vtB", level: "variantType" },
    ]);
    await expect(
      runChecklistStep(client, { rowId: "vtB" as never, sportId: "sp" as never, checklist: { ...CHECKLIST, expectCards: undefined }, at: "a", row: null }),
    ).rejects.toThrow(/does not re-sync them\. Review it in the Set Builder: \/admin\/set-builder\?sport=sp&year=yr&brand=mf&set=st&type=vtB$/);
    expect(client.callsTo("selectorOptions:getAncestorChain").map((c) => c.args)).toEqual([{ id: "vtB" }]);
    expect(client.callsTo("selectorOptions:resolveChecklistEntities")).toEqual([]);
  });
});

describe("Match Cards unlink on the apply path (NEO-339: #482 Henderson / Gwynn)", () => {
  /** BSC lists Gwynn #482, SportLots Henderson #482; the server matched them on the number. */
  const pair482 = {
    _id: "c482",
    cardNumber: "482",
    cardName: "Tony Gwynn",
    players: ["Tony Gwynn"],
    platformData: { bsc: { ref: "b482" }, sportlots: { ref: "s482" } },
    bucket: "matched",
    confidence: 1,
    nameConflict: { bsc: "Tony Gwynn", sportlots: "Rickey Henderson" },
    playersConflict: { bsc: ["Tony Gwynn"], sportlots: ["Rickey Henderson"] },
    stem: "482",
    teamResolved: true,
  };
  function client482(extra: Array<Record<string, unknown>> = []) {
    let batch: string | undefined;
    let cards = 0;
    const live = [pair482, ...extra];
    return fakeClient()
      .on("selectorOptions:getSlotCardCounts", () => ({ bsc: {}, sportlots: {}, total: cards }))
      .on("checklistCandidates:getReadyCandidates", () => ({
        batchId: batch,
        total: batch ? live.length : 0,
        ready: live.length,
        cards: batch ? live : [],
      }))
      .on("selectorOptions:fetchCardChecklist", () => {
        batch = "cb";
        return { success: true, message: "", candidateCount: live.length, attachedSides: ["bsc", "sportlots"], pausedSides: [] };
      })
      .on("selectorOptions:diffChecklistAgainstExisting", { cards: [], removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 }, conflicts: [], collisionInsertCount: 0 })
      .on("selectorOptions:resolveChecklistEntities", { unknownPlayers: [], unknownTeams: [] })
      .on("selectorOptions:commitCardChecklist", (args) => {
        cards = (args.cards as unknown[]).length;
        return { count: cards, conflicts: [] };
      })
      .on("checklistCandidates:discardCandidates", null);
  }
  const input = (pairing: Record<string, unknown>) => ({
    rowId: "i1" as never,
    sportId: "sp" as never,
    checklist: { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep", ...pairing }, review: "none-expected", expectCards: 2 } as never,
    at: "steps[0].variants[0].rows[0].checklist",
    row: { type: "Insert", name: "All Time Rookie Reprints" },
  });

  test("without an answer the conflicts are open, the fill-in offers the unlink, and nothing is committed", async () => {
    const client = client482();
    const r = await runChecklistStep(client, input({}));
    if (r.outcome !== "open") throw new Error(`expected open, got ${r.outcome}`);
    expect(r.open.conflicts.map((c) => c.cardNumber)).toEqual(["482", "482"]);
    expect(JSON.stringify(r.template)).toContain("pairing.unlink");
    expect(client.callsTo("selectorOptions:commitCardChecklist")).toEqual([]);
  });

  test("an unlinked pair commits as two kept cards, each with its own marketplace ref; no conflict is open", async () => {
    const client = client482();
    const r = await runChecklistStep(client, input({ unlink: [{ bsc: "b482", sportlots: "s482" }] }));
    if (r.outcome !== "committed") throw new Error(`expected committed, got ${JSON.stringify(r)}`);
    expect(r).toMatchObject({ committed: 2, cards: 2, pairing: "0 matched (1 unlinked), 1 BSC-only kept, 1 SportLots-only kept, 0 dropped" });
    const sent = client.callsTo("selectorOptions:commitCardChecklist")[0].args.cards as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cardNumber: "482", cardName: "Tony Gwynn", players: ["Tony Gwynn"], platformData: { bsc: { ref: "b482" } } }),
        expect.objectContaining({ cardNumber: "482", cardName: "Rickey Henderson", players: ["Rickey Henderson"], platformData: { sportlots: { ref: "s482" } } }),
      ]),
    );
    // Neither card carries the pair's disagreement any more.
    for (const c of sent) {
      expect(c.nameConflict).toBeUndefined();
      expect(c.playersConflict).toBeUndefined();
    }
  });

  test("an unlink whose two cards are fetched but not paired to each other is met: the summary says already apart", async () => {
    const card7 = {
      _id: "c7",
      cardNumber: "7",
      cardName: "Someone",
      platformData: { bsc: { ref: "b7" } },
      bucket: "bscOnly",
      stem: "7",
      teamResolved: true,
    };
    const client = client482([card7]);
    const r = await runChecklistStep(
      client,
      {
        ...input({ unlink: [{ bsc: "b482", sportlots: "s482" }, { bsc: "b7", sportlots: "s482" }] }),
        checklist: {
          pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep", unlink: [{ bsc: "b482", sportlots: "s482" }, { bsc: "b7", sportlots: "s482" }] },
          review: "none-expected",
          expectCards: 3,
        } as never,
      },
    );
    if (r.outcome !== "committed") throw new Error(`expected committed, got ${JSON.stringify(r)}`);
    expect(r.pairing).toBe("0 matched (1 unlinked, 1 already apart), 2 BSC-only kept, 1 SportLots-only kept, 0 dropped");
  });

  test("a count checked after the commit fails the step and carries what it saved", async () => {
    const client = client482();
    const err = await runChecklistStep(client, {
      ...input({}),
      checklist: {
        pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep", unlink: [{ bsc: "b482", sportlots: "s482" }] },
        review: "none-expected",
        expectCards: 3,
      } as never,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChecklistStepError);
    expect(err).toMatchObject({
      message: "steps[0].variants[0].rows[0].checklist: saved 2 cards; the row now holds 2, the spec expects 3.",
      committed: 2,
      progress: "0 matched (1 unlinked), 1 BSC-only kept, 1 SportLots-only kept, 0 dropped",
    });
  });
});

describe("build-parallel", () => {
  const plan = (hasCards: boolean, sides = { bsc: true, sportlots: false }) => ({
    source: { id: "vtB", value: "Base", kind: "base", hasCards: true },
    parallels: [
      { _id: "p1", value: "Gold Wave Refractors", sides, hasCards: false },
      { _id: "p2", value: "Sepia Refractors", sides, hasCards },
    ],
    truncated: false,
  });

  test("skips a parallel that has cards unless rebuild", async () => {
    const client = fakeClient()
      .on("parallelChecklistBuild:getParallelsForBuild", plan(true))
      .on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 300 });
    const r = await buildParallel(client, { sourceId: "vtP" as never, name: "Sepia Refractors", expectCards: 300, at: "x" });
    expect(r.outcome).toBe("skipped");
    expect(client.writes()).toEqual([]);
  });

  test("rebuild sends the build", async () => {
    const client = fakeClient()
      .on("parallelChecklistBuild:getParallelsForBuild", plan(true))
      .on("parallelChecklistBuild:buildParallelChecklist", { status: "built", copied: 300 })
      .on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 300 });
    const r = await buildParallel(client, { sourceId: "vtP" as never, name: "Sepia Refractors", rebuild: true, at: "x" });
    expect(r).toMatchObject({ outcome: "built", built: 300 });
    expect(client.callsTo("parallelChecklistBuild:buildParallelChecklist")[0].args).toEqual({ parallelId: "p2" });
  });

  test("a parallel with no marketplace id of its own is never sent", async () => {
    const client = fakeClient().on("parallelChecklistBuild:getParallelsForBuild", plan(false, { bsc: false, sportlots: false }));
    await expect(buildParallel(client, { sourceId: "vtP" as never, name: "Sepia Refractors", at: "x" })).rejects.toBeInstanceOf(BuildParallelError);
    expect(client.writes()).toEqual([]);
  });

  test("built 0 while the parallel's own listing returned cards: no-shared-numbers, naming the source; expecting 0 accepts it empty", async () => {
    const answer = {
      status: "built",
      copied: 0,
      extraOnMarketplace: { bsc: { count: 5, cards: [] }, sportlots: { count: 0, cards: [] } },
    };
    const client = fakeClient()
      .on("parallelChecklistBuild:getParallelsForBuild", plan(false))
      .on("parallelChecklistBuild:buildParallelChecklist", answer)
      .on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 0 });
    const r = await buildParallel(client, { sourceId: "vtP" as never, name: "Sepia Refractors", expectCards: 300, at: "x" });
    expect(r).toMatchObject({ outcome: "no-shared-numbers", cards: 0, listed: { bsc: 5, sportlots: 0 }, source: "Base" });
    const empty = await buildParallel(client, { sourceId: "vtP" as never, name: "Sepia Refractors", expectCards: 0, at: "x" });
    expect(empty).toMatchObject({ outcome: "built", built: 0, cards: 0 });
  });

  test("a count that misses the expectation fails loudly", async () => {
    const client = fakeClient()
      .on("parallelChecklistBuild:getParallelsForBuild", plan(false))
      .on("parallelChecklistBuild:buildParallelChecklist", { status: "built", copied: 299 })
      .on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 299 });
    await expect(buildParallel(client, { sourceId: "vtP" as never, name: "Sepia Refractors", expectCards: 300, at: "x" })).rejects.toThrow(/expects 300/);
  });
});

describe("counts with a marketplace paused (NEO-339: the seed under a SportLots pause)", () => {
  const SL_PAUSED = pausedContextOf(["sportlots"]);
  /** CI with SportLots paused: the Base is mapped BSC-only and its fetch keeps BSC's 335. */
  function committing(saved: number, fetch: { attachedSides?: string[]; pausedSides?: string[] } = {}) {
    let batch: string | undefined;
    let cards = 0;
    const client = fakeClient()
      .on("selectorOptions:getSlotCardCounts", () => ({ bsc: {}, sportlots: {}, total: cards }))
      .on("checklistCandidates:getReadyCandidates", () => ({
        batchId: batch,
        total: batch ? 1 : 0,
        ready: 1,
        cards: batch ? [{ _id: "c1", cardNumber: "1", cardName: "A", platformData: { bsc: { ref: "b1" } }, bucket: "bscOnly", stem: "1", teamResolved: true }] : [],
      }))
      .on("selectorOptions:fetchCardChecklist", () => {
        batch = "cb";
        return { success: true, message: "", candidateCount: 1, attachedSides: fetch.attachedSides ?? ["bsc"], pausedSides: fetch.pausedSides ?? [] };
      })
      .on("selectorOptions:diffChecklistAgainstExisting", { cards: [], removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 }, conflicts: [], collisionInsertCount: 0 })
      .on("selectorOptions:resolveChecklistEntities", { unknownPlayers: [], unknownTeams: [] })
      .on("selectorOptions:commitCardChecklist", () => {
        cards = saved;
        return { count: saved, conflicts: [] };
      })
      .on("checklistCandidates:discardCandidates", null);
    return client;
  }
  const BASE = { ...CHECKLIST, expectCards: 336 };
  const step = (client: ReturnType<typeof committing>, checklist: Record<string, unknown>, paused?: ReturnType<typeof pausedContextOf>) =>
    runChecklistStep(client, { rowId: "vtB" as never, sportId: "sp" as never, checklist: checklist as never, at: "steps[1].base.checklist", row: null, paused });

  test("not paused: the live count is asserted, exactly as before (the CI message)", async () => {
    await expect(step(committing(335), { ...BASE, expectCardsWhenPaused: 335 })).rejects.toThrow(
      "steps[1].base.checklist: saved 335 cards; the row now holds 335, the spec expects 336.",
    );
  });

  test("paused with expectCardsWhenPaused: that value is asserted, and passes", async () => {
    const r = await step(committing(335), { ...BASE, expectCardsWhenPaused: 335 }, SL_PAUSED);
    expect(r).toMatchObject({ outcome: "committed", committed: 335, cards: 335 });
    if (r.outcome === "committed") expect(r.notes.some((n) => n.includes("not asserted"))).toBe(false);
  });

  test("paused with expectCardsWhenPaused: a different count fails, naming the paused field", async () => {
    await expect(step(committing(334), { ...BASE, expectCardsWhenPaused: 335 }, SL_PAUSED)).rejects.toThrow(
      "steps[1].base.checklist: saved 334 cards; the row now holds 334, the spec expects 335 with sportlots paused (expectCardsWhenPaused).",
    );
  });

  test("paused with no paused value: nothing asserted, never the live 336, and the step says so", async () => {
    const r = await step(committing(335), BASE, SL_PAUSED);
    expect(r).toMatchObject({ outcome: "committed", cards: 335 });
    if (r.outcome === "committed") expect(r.notes).toContain("count not asserted: sportlots paused");
  });

  test("a side the fetch itself reports paused counts as paused too", async () => {
    const r = await step(committing(335, { attachedSides: ["bsc", "sportlots"], pausedSides: ["sportlots"] }), { ...BASE, expectCardsWhenPaused: 335 });
    expect(r).toMatchObject({ outcome: "committed", cards: 335 });
  });

  test("the idempotent pre-check: a paused re-run of a row holding the paused count is skipped before any fetch", async () => {
    const client = fakeClient().on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 335 });
    expect(await step(client as never, { ...BASE, expectCardsWhenPaused: 335 }, SL_PAUSED)).toMatchObject({ outcome: "skipped", detail: "already holds 335 cards" });
    // No paused value: any cards count as done, and the detail says the count was not asserted.
    expect(await step(client as never, BASE, SL_PAUSED)).toMatchObject({
      outcome: "skipped",
      detail: "already holds 335 cards; count not asserted: sportlots paused",
    });
    expect(client.calls.map((c) => c.fn)).toEqual(["selectorOptions:getSlotCardCounts", "selectorOptions:getSlotCardCounts"]);
    // Not paused, the same row is refused as before.
    await expect(step(client as never, BASE)).rejects.toThrow("the row already holds 335 cards and the spec expects 336. ");
  });

  test("checklistDone takes the run's check: a paused value that differs is refused, naming it", () => {
    expect(() => checklistDone(300, checklistCount({ expectCards: 336, expectCardsWhenPaused: 335 }, SL_PAUSED), "x")).toThrow(
      "x: the row already holds 300 cards and the spec expects 335 with sportlots paused (expectCardsWhenPaused). ",
    );
    expect(checklistDone(300, checklistCount({ expectCards: 336 }, SL_PAUSED), "x")).toBe(true);
  });

  describe("build-parallel", () => {
    const plan = (hasCards: boolean) => ({
      source: { id: "vtB", value: "Base", kind: "base", hasCards: true },
      parallels: [{ _id: "p2", value: "Sepia Refractors", sides: { bsc: true, sportlots: false }, hasCards }],
      truncated: false,
    });
    const building = (built: number) =>
      fakeClient()
        .on("parallelChecklistBuild:getParallelsForBuild", plan(false))
        .on("parallelChecklistBuild:buildParallelChecklist", { status: "built", copied: built })
        .on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: built });
    const input = { sourceId: "vtP" as never, name: "Sepia Refractors", expectCards: 300, at: "steps[0].variants[1].rows[0]" };

    test("paused with no paused value: built, nothing asserted, a note", async () => {
      const r = await buildParallel(building(250), { ...input, paused: SL_PAUSED });
      expect(r).toMatchObject({ outcome: "built", built: 250, note: "count not asserted: sportlots paused" });
    });

    test("paused with a paused value: asserted (pass and mismatch)", async () => {
      expect(await buildParallel(building(250), { ...input, expectCardsWhenPaused: 250, paused: SL_PAUSED })).toMatchObject({ outcome: "built", cards: 250 });
      await expect(buildParallel(building(249), { ...input, expectCardsWhenPaused: 250, paused: SL_PAUSED })).rejects.toThrow(
        'built 249 cards onto "Sepia Refractors"; it now holds 249, the spec expects 250 with sportlots paused (expectCardsWhenPaused).',
      );
    });

    test("not paused: the live count, as before (the paused value is not read)", async () => {
      await expect(buildParallel(building(250), { ...input, expectCardsWhenPaused: 250 })).rejects.toThrow(
        'built 250 cards onto "Sepia Refractors"; it now holds 250, the spec expects 300.',
      );
    });
  });
});
