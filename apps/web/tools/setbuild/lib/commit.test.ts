import { describe, expect, test } from "vitest";
import { fakeClient } from "../runner/fake-client";
import { buildParallel, BuildParallelError } from "./build-parallel";
import { checklistDone, runChecklistStep } from "./commit";
import { ChecklistStepError } from "./fetch-checklist";

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
    await expect(
      runChecklistStep(client, { rowId: "vtB" as never, sportId: "sp" as never, checklist: { ...CHECKLIST, expectCards: undefined }, at: "a", row: null }),
    ).rejects.toThrow(/does not re-sync/);
    expect(client.callsTo("selectorOptions:resolveChecklistEntities")).toEqual([]);
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

  test("a count that misses the expectation fails loudly", async () => {
    const client = fakeClient()
      .on("parallelChecklistBuild:getParallelsForBuild", plan(false))
      .on("parallelChecklistBuild:buildParallelChecklist", { status: "built", copied: 299 })
      .on("selectorOptions:getSlotCardCounts", { bsc: {}, sportlots: {}, total: 299 });
    await expect(buildParallel(client, { sourceId: "vtP" as never, name: "Sepia Refractors", expectCards: 300, at: "x" })).rejects.toThrow(/expects 300/);
  });
});
